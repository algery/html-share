import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

export async function mainEnvironment(config, h) {
  const example = parseEnv(await readFile(new URL("../.env.example", import.meta.url), "utf8"));
  return {
    ...example,
    PATH: process.env.PATH,
    DATABASE_URL: config.databaseUrl,
    OBJECT_STORAGE_ENDPOINT: config.endpoint,
    OBJECT_STORAGE_PUBLIC_ENDPOINT: config.endpoint,
    OBJECT_STORAGE_ACCESS_KEY_ID: config.accessKeyId,
    OBJECT_STORAGE_ACCESS_KEY_SECRET: config.accessKeySecret,
    OBJECT_STORAGE_BUCKET: h.bucket,
    SERVER_PORT: "55101",
    WORKER_PORT: "55102",
    DEMO_WEB_URL: "https://demo.localhost:55101",
    TRUSTED_PROXY_IPS: "127.0.0.1",
    PASSWORD_RESULT_ENCRYPTION_KEY: process.env.PASSWORD_RESULT_ENCRYPTION_KEY,
    PASSWORD_MANAGEMENT_ENCRYPTION_KEY: process.env.PASSWORD_MANAGEMENT_ENCRYPTION_KEY,
  };
}

export function mainProcesses() {
  const children = [];
  let captured = "";
  return {
    start(app, env) {
      const child = spawn(process.execPath, [`apps/${app}/dist/main.js`], {
        cwd: new URL("../", import.meta.url),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const entry = { child, stopped: false, failure: false };
      entry.closed = new Promise((resolve) => {
        child.once("error", () => {
          entry.failure = true;
        });
        child.once("close", () => {
          entry.stopped = true;
          resolve();
        });
      });
      children.push(entry);
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", (chunk) => {
          captured += chunk;
        });
      }
    },
    alive() {
      return children.every((entry) => !entry.stopped && !entry.failure);
    },
    logs() {
      return captured;
    },
    async stop() {
      await Promise.all(
        children.map(async (entry) => {
          if (entry.stopped) return;
          entry.child.kill("SIGTERM");
          const timer = setTimeout(() => entry.child.kill("SIGKILL"), 5000);
          try {
            await entry.closed;
          } finally {
            clearTimeout(timer);
          }
        }),
      );
    },
  };
}

export async function eventually(operation, message, check, processes) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!processes.alive()) {
      check(false, "owned main processes remain alive");
      return;
    }
    if (await operation()) {
      check(true, message);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check(false, message);
}

export function noSecretFields(value) {
  if (Array.isArray(value)) return value.every(noSecretFields);
  if (value === null || typeof value !== "object") return true;
  return Object.entries(value).every(([key, nested]) => {
    if (/(?:password|authorization|cookie|token|secret|signature|body|content|payload)/i.test(key))
      return nested === "[REDACTED]";
    return noSecretFields(nested);
  });
}
