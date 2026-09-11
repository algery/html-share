import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildDistributions } from "../skills/build-distributions.mjs";
import { createHarness, isolatedConfiguration } from "./password-smoke-support.mjs";
import { startPasswordHttps } from "./password-https-harness.mjs";
import { responseCookies, responseState } from "./password-access-fixture.mjs";

const execute = promisify(execFile);
let assertions = 0;
function check(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}
const config = isolatedConfiguration();
const directory = await mkdtemp(join(tmpdir(), "html-share-password-skill-"));
let h;
let https;
let stop = false;
let worker;
let workerError;
const results = [];
try {
  await buildDistributions();
  h = await createHarness(config, check, {
    passwordAccess: true,
    demoUrl: "https://localhost:55443",
  });
  https = await startPasswordHttps();
  worker = (async () => {
    while (!stop) {
      try {
        await h.finalize();
      } catch {
        workerError = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  })();
  const publishDir = join(directory, "source");
  await mkdir(join(publishDir, "nested"), { recursive: true });
  const target = "nested/测试 file.html";
  const body =
    "<!doctype html><html><head><title>Package smoke</title></head><body><h1>Package fixture</h1></body></html>";
  await writeFile(join(publishDir, target), body);
  const sourceBefore = await treeDigest(publishDir);
  for (const [host, archive, prefix] of [
    ["Codex", "codex-html-share.zip", ".codex"],
    ["Claude Code", "claude-code-html-share.zip", ".claude"],
  ]) {
    const installDir = join(directory, prefix);
    const packaged = join("skills/html-share/dist", archive);
    check(
      (await readFile(packaged)).equals(await readFile(join("apps/web/public/skills", archive))),
      "download and distribution archives match",
    );
    await execute("unzip", ["-q", packaged, "-d", installDir]);
    const root = join(installDir, prefix, "skills/html-share");
    check(
      (await treeDigest(root)) === (await treeDigest("skills/html-share")),
      "installed package equals shared source excluding dist",
    );
    const script = join(root, "scripts/upload.mjs");
    async function cli(options = [], query = false) {
      const args = [
        script,
        "--target-html",
        target,
        "--mcp-url",
        h.mcpUrl,
        "--demo-url",
        h.demoUrl,
        ...(query ? [] : ["--publish-dir", publishDir]),
        ...options,
      ];
      let output;
      try {
        output = await execute(process.execPath, args, {
          env: { ...process.env, HTML_SHARE_MCP_TOKEN: h.mcpToken },
          timeout: 25_000,
          maxBuffer: 128_000,
        });
      } catch (error) {
        // execFile errors include captured stdout: never print a possible password result.
        throw new Error(
          `Packaged CLI failed (${typeof error.code === "number" ? error.code : "process"}); ${host}; killed=${Boolean(error.killed)}; stdoutBytes=${Buffer.byteLength(error.stdout ?? "")}; stderrBytes=${Buffer.byteLength(error.stderr ?? "")}; workerFailed=${Boolean(workerError)}`,
        );
      }
      check(output.stderr === "", "successful CLI has no debug output");
      const result = JSON.parse(output.stdout);
      check(!output.stdout.includes(h.mcpToken), "result excludes publisher token");
      return result;
    }
    const organization = await cli(["--action", "create"]);
    check(
      organization.accessMode === "organization" && organization.accessPassword === undefined,
      "default publication has no password",
    );
    const requestId = randomUUID();
    const createOptions = [
      "--action",
      "create",
      "--access-mode",
      "password",
      "--client-request-id",
      requestId,
    ];
    const password = await cli(createOptions);
    check(
      password.passwordStatus === "generated" && typeof password.accessPassword === "string",
      "explicit password publication returns generated result",
    );
    const repeated = await cli(createOptions);
    check(
      repeated.uploadId === password.uploadId &&
        repeated.accessPassword === password.accessPassword,
      "same request returns identical upload and password",
    );
    const recovered = await cli(
      ["--upload-id", password.uploadId, "--project-id", password.projectId],
      true,
    );
    check(
      recovered.accessPassword === password.accessPassword,
      "read-only task query recovers exact generated password",
    );
    const initialGrant = await unlock(password);
    const inherited = await cli(["--action", "replace", "--project-id", password.projectId]);
    check(
      inherited.passwordStatus === "retained" &&
        inherited.passwordMessage === "沿用原密码" &&
        inherited.accessPassword === undefined,
      "replacement inherits without inventing password",
    );
    check(
      (
        await https.request(new URL(password.shareUrl).pathname, {
          headers: { cookie: initialGrant },
        })
      ).status === 200,
      "inherited revision accepts original project grant",
    );
    const reset = await cli([
      "--action",
      "replace",
      "--project-id",
      password.projectId,
      "--regenerate-password",
    ]);
    check(
      reset.passwordStatus === "generated" && reset.accessPassword !== password.accessPassword,
      "explicit reset returns new real password",
    );
    check(
      (
        await https.request(new URL(password.shareUrl).pathname, {
          headers: { cookie: initialGrant },
        })
      ).status === 302,
      "reset invalidates old grant",
    );
    const resetGrant = await unlock(reset);
    const stale = await cli(
      ["--upload-id", password.uploadId, "--project-id", password.projectId],
      true,
    );
    check(
      stale.passwordStatus === "unavailable" && stale.accessPassword === undefined,
      "old task does not disclose replaced password",
    );
    const closed = await cli([
      "--action",
      "replace",
      "--project-id",
      password.projectId,
      "--access-mode",
      "organization",
    ]);
    check(
      closed.accessMode === "organization" && closed.accessPassword === undefined,
      "explicit close returns organization result",
    );
    const blocked = await https.request(new URL(password.shareUrl).pathname, {
      headers: { cookie: resetGrant },
    });
    check(
      blocked.status === 302 && blocked.headers.location.includes("/auth/content-login"),
      "closed password mode requires organization login",
    );
    check((await treeDigest(publishDir)) === sourceBefore, "CLI never changes publisher source");
    results.push({
      host,
      scenarios: [
        "default",
        "password",
        "idempotent-retry",
        "query",
        "inherit",
        "reset",
        "stale-query",
        "close",
      ],
      status: "passed",
    });
  }
  check(!workerError, "real worker finalizer loop succeeds");
  const metrics = h.publicationMetrics();
  check(
    metrics.worker.getObjectCalls === 0 && metrics.worker.bodyBytesRead === 0,
    "worker publishes without reading object bodies",
  );
  console.log(
    JSON.stringify({
      status: "password-skill-smoke-ok",
      assertions,
      packages: results,
      realHttps: true,
      worker: metrics.worker,
    }),
  );

  async function unlock(result) {
    const path = new URL(result.shareUrl).pathname;
    check(!result.shareUrl.includes(result.accessPassword), "password is separate from link");
    const entry = await https.request(path);
    check(
      entry.status === 302 && entry.headers.location.startsWith("/auth/password"),
      "package link requires password authorization",
    );
    const page = await https.request(entry.headers.location);
    const response = await https.request("/auth/password/verify", {
      method: "POST",
      headers: {
        cookie: responseCookies(page),
        origin: h.demoUrl,
        "content-type": "application/json",
      },
      body: JSON.stringify({ state: responseState(page), password: result.accessPassword }),
    });
    check(response.status === 200, "actual packaged CLI password unlocks HTTPS link");
    const grant = responseCookies(response);
    const content = await https.request(path, { headers: { cookie: grant } });
    check(
      content.status === 200 && content.body.toString() === body,
      "password grant reads original accurate HTML bytes",
    );
    return grant;
  }
} finally {
  stop = true;
  await worker;
  try {
    if (https) await https.close();
  } finally {
    try {
      if (h) await h.cleanup();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function treeDigest(directory) {
  const hash = createHash("sha256");
  async function visit(relative = "") {
    for (const entry of (await readdir(join(directory, relative), { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (entry.name === "dist" || entry.name === ".DS_Store") continue;
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        hash.update(path);
        hash.update(await readFile(join(directory, path)));
      }
    }
  }
  await visit();
  return hash.digest("hex");
}
