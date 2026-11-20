import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { inside, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from "./common.mjs";

export const MAX_COVER_BYTES = 1024 * 1024;
export const COVER_CAPTURE_TIMEOUT_MS = 12_000;
export const COVER_CAPTURE_CLEANUP_MS = 500;

export async function capturePreparedCover(inspection, projectId, homepage) {
  const deadline = Date.now() + COVER_CAPTURE_TIMEOUT_MS;
  const home = homedir();
  const runtimeDir = process.env["HTML_SHARE_COVER_RUNTIME"] ?? join(home, ".html-share-cover");
  if (!isAbsolute(runtimeDir)) return null;
  let playwright;
  try {
    playwright = createRequire(join(runtimeDir, "package.json")).resolve("playwright");
  } catch {
    return null;
  }

  const files = inspection.sourceFiles;
  if (
    files.length > MAX_FILES ||
    !files.some((file) => file.path === homepage && file.mimeType.startsWith("text/html;"))
  ) {
    return null;
  }
  let totalBytes = 0;
  const assets = new Map();
  for (const file of files) {
    totalBytes += file.size;
    if (file.size > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES || Date.now() >= deadline) {
      return null;
    }
    assets.set(file.path, {
      body: await readApprovedFile(inspection.publishDir, file),
      mimeType: file.mimeType,
    });
  }
  const scratch = await mkdtemp(join(tmpdir(), "html-share-cover-"));
  try {
    const browsersPath = process.env["PLAYWRIGHT_BROWSERS_PATH"] ?? "0";
    if (Date.now() >= deadline || (browsersPath !== "0" && !isAbsolute(browsersPath))) return null;
    return await renderInChild({
      scratch,
      browsersPath,
      deadline,
      scriptInput: { playwright, projectId, homepage, assets },
    });
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

async function readApprovedFile(root, file) {
  if (!inside(root, file.sourcePath) || (await realpath(file.logicalPath)) !== file.sourcePath) {
    throw new Error("预检文件已变化。");
  }
  const handle = await open(
    file.sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size !== file.size ||
      before.dev !== file.dev ||
      before.ino !== file.ino
    ) {
      throw new Error("预检文件已变化。");
    }
    const body = Buffer.alloc(file.size);
    let offset = 0;
    while (offset < body.length) {
      const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
      if (bytesRead === 0) throw new Error("预检文件已变化。");
      offset += bytesRead;
    }
    if (
      createHash("sha256").update(body).digest("hex") !== file.hash ||
      createHash("md5").update(body).digest("base64") !== file.contentMd5
    ) {
      throw new Error("预检文件已变化。");
    }
    return body;
  } finally {
    await handle.close();
  }
}

function renderInChild({ scratch, browsersPath, deadline, scriptInput }) {
  return new Promise((resolve) => {
    const child = fork(new URL("./render-cover.mjs", import.meta.url), {
      cwd: scratch,
      env: {
        HOME: scratch,
        USERPROFILE: scratch,
        TMPDIR: scratch,
        TEMP: scratch,
        TMP: scratch,
        PLAYWRIGHT_BROWSERS_PATH: browsersPath,
        ...(process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] } : {}),
      },
      execArgv: [],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let image = null;
    let timedOut = false;
    let forceBrowserTimer;
    let killTimer;
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGTERM");
        // A second termination signal lets Playwright kill the detached
        // Chromium process group if its graceful shutdown is still pending.
        forceBrowserTimer = setTimeout(() => child.kill("SIGTERM"), COVER_CAPTURE_CLEANUP_MS / 2);
        forceBrowserTimer.unref();
        killTimer = setTimeout(() => child.kill("SIGKILL"), COVER_CAPTURE_CLEANUP_MS);
        killTimer.unref();
      },
      Math.max(1, deadline - Date.now()),
    );
    child.once("message", (result) => {
      if (Buffer.isBuffer(result) && result.length <= MAX_COVER_BYTES) image = result;
    });
    child.on("error", () => {
      image = null;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(forceBrowserTimer);
      clearTimeout(killTimer);
      resolve(code === 0 && !timedOut ? image : null);
    });
    child.send(scriptInput);
  });
}
