import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 500;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function inside(root, candidate) {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

export function normalizeRelativePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    value.startsWith("/") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("target_html 必须是发布目录内的规范化相对路径。");
  }
  return value;
}

export function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new Error(`不支持的参数：${item}`);
    const key = item.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`参数 --${item.slice(2)} 缺少值。`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

export function createClientRequestId(value) {
  return value ?? randomUUID();
}

export function redact(value) {
  return typeof value === "string"
    ? value.replace(/Bearer\s+[A-Za-z0-9_-]+/gi, "Bearer [REDACTED]")
    : value;
}
