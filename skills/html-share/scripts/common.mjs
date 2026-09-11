import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isMainModule(moduleUrl) {
  return (
    process.argv[1] !== undefined &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl))
  );
}

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 500;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export function mimeForPath(path) {
  const extension = path.split(".").at(-1)?.toLowerCase();
  const known = {
    css: "text/css; charset=utf-8",
    gif: "image/gif",
    htm: "text/html; charset=utf-8",
    html: "text/html; charset=utf-8",
    ico: "image/x-icon",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    png: "image/png",
    svg: "image/svg+xml",
    webp: "image/webp",
  };
  return extension === undefined
    ? "application/octet-stream"
    : (known[extension] ?? "application/octet-stream");
}

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
    /%(?:00|2e|2f|5c)/i.test(value) ||
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
    if (!item.startsWith("--")) throw new Error("不支持的位置参数，请使用具名选项。");
    const key = item.slice(2).replaceAll("-", "_");
    if (Object.hasOwn(parsed, key)) throw new Error("不能重复指定同一参数。");
    if (key === "regenerate_password") {
      parsed[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`参数 --${item.slice(2)} 缺少值。`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

export function createClientRequestId(value) {
  if (
    value !== undefined &&
    (typeof value !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value))
  )
    throw new Error("client_request_id 必须是有效 UUID。");
  return value ?? randomUUID();
}

export function redact(value) {
  return typeof value === "string"
    ? value.replace(/Bearer\s+[A-Za-z0-9_-]+/gi, "Bearer [REDACTED]")
    : value;
}
