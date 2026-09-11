import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

// Keep real logger output and test credentials in memory until leakage checks pass.
const child = spawn(process.execPath, ["scripts/password-security-worker.mjs"], {
  env: process.env,
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
let stdout = "";
let stderr = "";
let secrets = [];
let report;
child.stdout.on("data", (value) => {
  stdout += value;
});
child.stderr.on("data", (value) => {
  stderr += value;
});
child.on("message", (message) => {
  if (message.type === "credentials") secrets = message.values;
  if (message.type === "report") report = message.value;
});
const timer = setTimeout(() => child.kill("SIGTERM"), 60000);
try {
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert(
    code === 0 && report && secrets.length > 0,
    `isolated security worker failed (exit=${code}, locations=${[...stderr.matchAll(/password-[a-z-]+\.mjs:[0-9]+/g)].map((x) => x[0]).join(",") || "setup"}); captured output withheld`,
  );
  assert(
    secrets.every((secret) => !stdout.includes(secret) && !stderr.includes(secret)),
    "runtime logger leaked a credential; captured output withheld",
  );
  const logs = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(
    logs.some((line) => line.msg === "request completed" && line.action === "authorization"),
    "real production logger authorization output observed",
  );
  assert(
    logs.some((line) => line.action === "mcp"),
    "real publication logs observed",
  );
  assert(
    logs.every(hasNoSensitiveFields),
    "runtime output excludes nested request bodies and credentials",
  );
  await writeFile("/private/tmp/html-share-phase13-security-runtime.log", stdout + stderr, {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      ...report,
      runtimeLogRecords: logs.length,
      runtimeLogLeakage: false,
      checkedCredentialValues: secrets.length,
    }),
  );
} finally {
  clearTimeout(timer);
  secrets = [];
  if (child.exitCode === null) child.kill("SIGTERM");
}

function hasNoSensitiveFields(value) {
  if (Array.isArray(value)) return value.every(hasNoSensitiveFields);
  if (value === null || typeof value !== "object") return true;
  return Object.entries(value).every(([key, nested]) => {
    if (/(?:password|authorization|cookie|token|secret|signature|body|content|payload)/i.test(key))
      return nested === "[REDACTED]";
    return hasNoSensitiveFields(nested);
  });
}
