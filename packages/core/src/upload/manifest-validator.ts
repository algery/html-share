import { createHash } from "node:crypto";

import {
  MAX_DEMO_FILE_BYTES,
  MAX_DEMO_FILES,
  MAX_DEMO_TOTAL_BYTES,
  type FileManifestItem,
} from "./contracts.js";
import { UploadError } from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/i;
const CONTENT_MD5 = /^[A-Za-z0-9+/]{22}==$/;

export function validateManifest(input: {
  files: readonly FileManifestItem[];
  manifestDigest: string;
  targetHtml: string;
}) {
  if (
    !Array.isArray(input.files) ||
    input.files.length < 1 ||
    input.files.length > MAX_DEMO_FILES
  ) {
    throw new UploadError("INVALID_UPLOAD_INPUT");
  }
  const paths = new Set<string>();
  let totalSize = 0;
  const files = input.files.map((file) => {
    const relativePath = normalizeRelativePath(file.relativePath);
    if (
      paths.has(relativePath) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_DEMO_FILE_BYTES ||
      !SHA256.test(file.sha256) ||
      !CONTENT_MD5.test(file.contentMd5) ||
      file.mimeType !== mimeForPath(relativePath)
    ) {
      throw new UploadError("INVALID_UPLOAD_INPUT");
    }
    paths.add(relativePath);
    totalSize += file.size;
    if (totalSize > MAX_DEMO_TOTAL_BYTES) throw new UploadError("INVALID_UPLOAD_INPUT");
    return {
      contentMd5: file.contentMd5,
      mimeType: file.mimeType,
      relativePath,
      sha256: file.sha256.toLowerCase(),
      size: file.size,
    };
  });
  if (!paths.has(input.targetHtml)) {
    throw new UploadError("INVALID_UPLOAD_INPUT");
  }
  const manifestDigest = digestManifest(files);
  if (!SHA256.test(input.manifestDigest) || manifestDigest !== input.manifestDigest.toLowerCase()) {
    throw new UploadError("INVALID_UPLOAD_INPUT");
  }
  return { files, manifestDigest, totalSize };
}

export function digestManifest(files: readonly FileManifestItem[]) {
  const canonical = [...files]
    .sort((left, right) => comparePaths(left.relativePath, right.relativePath))
    .map(
      (file) =>
        `${file.relativePath}\u0000${file.size}\u0000${file.sha256.toLowerCase()}\u0000${file.contentMd5}\u0000${file.mimeType}\n`,
    )
    .join("");
  return createHash("sha256").update(canonical).digest("hex");
}

function comparePaths(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function mimeForPath(path: string) {
  const extension = path.split(".").at(-1)?.toLowerCase();
  const known: Record<string, string> = {
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

export function normalizeRelativePath(value: string) {
  if (
    value.length < 1 ||
    value.length > 1024 ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    /%(?:00|2e|2f|5c)/i.test(value) ||
    value.startsWith("/")
  ) {
    throw new UploadError("INVALID_UPLOAD_INPUT");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new UploadError("INVALID_UPLOAD_INPUT");
  }
  return segments.join("/");
}
