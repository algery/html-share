import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function describeUploadFile(sourcePath, relativePath) {
  const [body, metadata] = await Promise.all([readFile(sourcePath), stat(sourcePath)]);
  if (!metadata.isFile()) throw new Error(`${relativePath} must be a regular file`);
  return {
    content_md5: createHash("md5").update(body).digest("base64"),
    mime_type: mimeForPath(relativePath),
    relative_path: relativePath,
    sha256: createHash("sha256").update(body).digest("hex"),
    size: body.length,
    sourcePath,
  };
}

export function directManifestDigest(files) {
  const canonical = [...files]
    .sort((left, right) =>
      left.relative_path < right.relative_path
        ? -1
        : left.relative_path > right.relative_path
          ? 1
          : 0,
    )
    .map(
      (file) =>
        `${file.relative_path}\u0000${file.size}\u0000${file.sha256.toLowerCase()}\u0000${file.content_md5}\u0000${file.mime_type}\n`,
    )
    .join("");
  return createHash("sha256").update(canonical).digest("hex");
}

export function publicManifest(files) {
  return files.map((file) => ({
    content_md5: file.content_md5,
    mime_type: file.mime_type,
    relative_path: file.relative_path,
    sha256: file.sha256,
    size: file.size,
  }));
}

export async function uploadPreparedFiles(prepared, files) {
  if (!Array.isArray(prepared.uploads) || prepared.uploads.length !== files.length) {
    throw new Error(`prepare must return ${files.length} exact upload contracts`);
  }
  const sources = new Map(files.map((file) => [file.relative_path, file.sourcePath]));
  await Promise.all(
    prepared.uploads.map(async (upload) => {
      const sourcePath = sources.get(upload.relative_path);
      if (sourcePath === undefined) throw new Error("prepare returned a path outside the manifest");
      const headers = Object.entries(upload.upload_headers).flatMap(([name, value]) => [
        "-H",
        `${name}: ${value}`,
      ]);
      const url = new URL(upload.upload_url);
      const resolve =
        url.hostname === "host.docker.internal"
          ? ["--resolve", "host.docker.internal:9000:127.0.0.1"]
          : [];
      await execute("curl", [
        "--fail",
        "--silent",
        "--show-error",
        ...resolve,
        ...headers,
        "--upload-file",
        sourcePath,
        upload.upload_url,
      ]);
    }),
  );
}

function mimeForPath(path) {
  const types = {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".htm": "text/html; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}
