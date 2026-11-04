import { readdir, readFile } from "node:fs/promises";
import { extname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const IGNORED_DIRECTORIES = new Set([
  ".agents",
  ".codex",
  ".git",
  ".next",
  "coverage",
  "dist",
  "node_modules",
  "postgres-data",
  "mysql-data",
  "release",
  "minio-data",
]);
const FORBIDDEN_EXTENSIONS = new Set([".key", ".p12", ".pfx", ".pem"]);
const SAFE_EXAMPLE_VALUES =
  /^(?:|example|local|change-me|replace-with-[a-z0-9-]+|local-development-(?:state-signing|mcp-token-hash)-key-change-before-production|[a-z0-9-]+-local(?:-(?:password|secret|key))?|[a-z0-9_]+_local)$/i;
const SENSITIVE_ASSIGNMENT =
  /^[ \t]*([A-Z0-9_]*(?:SECRET|PASSWORD|PRIVATE_KEY|ACCESS_TOKEN|API_TOKEN|API_KEY|CREDENTIAL)[A-Z0-9_]*)[ \t]*=[ \t]*([^\r\n]*)[ \t]*$/gm;
const DINGTALK_SECRET_VALUE =
  /(?:DINGTALK_CLIENT_SECRET|Client Secret)\s*[:=：][ \t]*[`'"]?([A-Za-z0-9_-]{32,})/i;
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryUrl)));
    } else if (entry.isFile()) {
      files.push(entryUrl);
    }
  }
  return files;
}

export function inspectFileName(pathname) {
  const name = pathname.split("/").at(-1) ?? "";
  const examples = new Set([".env.example", ".env.mysql.example"]);
  const unsafeEnv = name === ".env" || (name.startsWith(".env.") && !examples.has(name));
  return unsafeEnv || FORBIDDEN_EXTENSIONS.has(extname(name).toLowerCase());
}

export function inspectContent(content) {
  const findings = [];
  if (PRIVATE_KEY_BLOCK.test(content)) {
    findings.push("private-key-block");
  }
  for (const match of content.matchAll(SENSITIVE_ASSIGNMENT)) {
    const value = match[2]?.replace(/^['"]|['"]$/g, "") ?? "";
    const isSyntheticPasswordKey =
      (match[1] === "PASSWORD_RESULT_ENCRYPTION_KEY" &&
        value === Buffer.alloc(32, 1).toString("base64")) ||
      (match[1] === "PASSWORD_MANAGEMENT_ENCRYPTION_KEY" &&
        value === Buffer.alloc(32, 2).toString("base64"));
    const isPasswordRateLimit =
      /^PASSWORD_VERIFY_(?:IP|IP_PROJECT|PROJECT)_RATE_LIMIT_PER_MINUTE$/.test(match[1]) &&
      /^[1-9][0-9]{0,5}$/.test(value) &&
      Number(value) <= 100_000;
    if (!SAFE_EXAMPLE_VALUES.test(value) && !isSyntheticPasswordKey && !isPasswordRateLimit) {
      findings.push(`non-placeholder-${match[1]}`);
    }
  }
  if (DINGTALK_SECRET_VALUE.test(content)) {
    findings.push("non-placeholder-DINGTALK_CLIENT_SECRET");
  }
  return findings;
}

export async function scanRoot(root, readText = readFile) {
  const findings = [];
  for (const file of await listFiles(root)) {
    const pathname = fileURLToPath(file);
    const displayPath = relative(fileURLToPath(root), pathname);
    if (inspectFileName(pathname)) {
      findings.push({ file: displayPath, reason: "forbidden-sensitive-file-name" });
      continue;
    }

    let content;
    try {
      content = await readText(file, "utf8");
    } catch {
      findings.push({ file: displayPath, reason: "read-failed" });
      continue;
    }
    for (const reason of inspectContent(content)) {
      findings.push({ file: displayPath, reason });
    }
  }
  return findings;
}
