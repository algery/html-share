import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function buildManagementWeb({ appUrl, check, demoUrl, webUrl }) {
  const result = await runProcess("pnpm", ["--filter", "@html-share/web", "build"], {
    NEXT_PUBLIC_API_URL: appUrl,
    NEXT_PUBLIC_APP_URL: webUrl,
    NEXT_PUBLIC_DEMO_URL: demoUrl,
  });
  check(result.code === 0, "production Web builds for the real management API");
}

export function startManagementWeb({ appUrl, demoUrl, webUrl }) {
  return spawn(
    process.execPath,
    [
      "apps/web/node_modules/next/dist/bin/next",
      "start",
      "apps/web",
      "-H",
      "127.0.0.1",
      "-p",
      new URL(webUrl).port,
    ],
    {
      env: {
        ...process.env,
        NEXT_PUBLIC_API_URL: appUrl,
        NEXT_PUBLIC_APP_URL: webUrl,
        NEXT_PUBLIC_DEMO_URL: demoUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

export async function waitForManagementWeb(webUrl, check) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`${webUrl}/api/health`);
      if (response.ok) {
        check(true, "production Web starts and becomes healthy");
        return;
      }
    } catch (error) {
      if (attempt === 79)
        throw new Error("production Web did not become healthy", { cause: error });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("production Web did not become healthy");
}

export async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("close", resolve));
}

export async function assertBuildExcludes(values, check) {
  const needles = values.filter(Boolean).map((value) => Buffer.from(value));
  for (const path of await filesUnder("apps/web/.next")) {
    let body;
    try {
      body = await readFile(path);
    } catch (error) {
      if (error?.code === "EISDIR") continue;
      throw error;
    }
    assert(
      needles.every((needle) => !body.includes(needle)),
      "Web build excludes runtime secrets",
    );
  }
  check(true, "Web build excludes runtime secrets");
}

async function runProcess(command, args, additions) {
  const child = spawn(command, args, {
    env: { ...process.env, ...additions },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (value) => (output += value));
  child.stderr.on("data", (value) => (output += value));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, output };
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    }),
  );
  return paths.flat();
}
