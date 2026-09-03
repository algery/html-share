import { createHash } from "node:crypto";
import { PassThrough, Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";

import { MAX_DEMO_FILE_BYTES, MAX_DEMO_FILES, MAX_DEMO_TOTAL_BYTES } from "./contracts.js";
import { normalizeRelativePath } from "./upload-service.js";

const MAX_COMPRESSION_RATIO = 100;

export interface ArchiveEntry {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  entry: yauzl.Entry;
}

export interface ExtractedFile {
  path: string;
  size: number;
  contentHash: string;
  mimeType: string;
}

export class ArchiveValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ArchiveValidationError";
  }
}

export async function inspectArchive(zipPath: string): Promise<ArchiveEntry[]> {
  const zip = await yauzl.openPromise(zipPath, {
    autoClose: false,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  const entries: ArchiveEntry[] = [];
  const normalizedPaths = new Set<string>();
  let totalSize = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      if (isSymlink(entry)) throw new ArchiveValidationError("ARCHIVE_SYMLINK_FORBIDDEN");
      if (isDirectory(entry)) continue;
      const path = normalizeArchivePath(entry.fileName);
      if (normalizedPaths.has(path)) throw new ArchiveValidationError("ARCHIVE_DUPLICATE_PATH");
      if (entry.uncompressedSize > MAX_DEMO_FILE_BYTES)
        throw new ArchiveValidationError("ARCHIVE_FILE_TOO_LARGE");
      if (entry.uncompressedSize < 0 || entry.compressedSize < 0)
        throw new ArchiveValidationError("ARCHIVE_SIZE_INVALID");
      if (
        entry.uncompressedSize > 0 &&
        (entry.compressedSize === 0 ||
          entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO)
      ) {
        throw new ArchiveValidationError("ARCHIVE_COMPRESSION_RATIO_EXCEEDED");
      }
      totalSize += entry.uncompressedSize;
      if (entries.length + 1 > MAX_DEMO_FILES)
        throw new ArchiveValidationError("ARCHIVE_FILE_COUNT_EXCEEDED");
      if (totalSize > MAX_DEMO_TOTAL_BYTES)
        throw new ArchiveValidationError("ARCHIVE_TOTAL_TOO_LARGE");
      normalizedPaths.add(path);
      entries.push({
        compressedSize: entry.compressedSize,
        entry,
        path,
        uncompressedSize: entry.uncompressedSize,
      });
    }
    if (entries.length === 0) throw new ArchiveValidationError("ARCHIVE_EMPTY");
    return entries;
  } catch (error) {
    if (error instanceof ArchiveValidationError) throw error;
    throw new ArchiveValidationError("ARCHIVE_INVALID");
  } finally {
    zip.close();
  }
}

export async function extractArchive(input: {
  zipPath: string;
  entries: readonly ArchiveEntry[];
  putFile: (file: {
    path: string;
    body: Readable;
    size: number;
    mimeType: string;
  }) => Promise<void>;
}): Promise<{ files: ExtractedFile[]; manifestDigest: string; totalSize: number }> {
  const zip = await yauzl.openPromise(input.zipPath, {
    autoClose: false,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  const expected = new Map(input.entries.map((item) => [item.path, item]));
  const files: ExtractedFile[] = [];
  let totalSize = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      if (isSymlink(entry)) throw new ArchiveValidationError("ARCHIVE_SYMLINK_FORBIDDEN");
      if (isDirectory(entry)) continue;
      const path = normalizeArchivePath(entry.fileName);
      const metadata = expected.get(path);
      if (metadata === undefined || metadata.entry.uncompressedSize !== entry.uncompressedSize) {
        throw new ArchiveValidationError("ARCHIVE_CHANGED_DURING_EXTRACTION");
      }
      const source = await zip.openReadStreamPromise(entry);
      const hash = createHash("sha256");
      let written = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          written += chunk.length;
          if (written > MAX_DEMO_FILE_BYTES || totalSize + written > MAX_DEMO_TOTAL_BYTES) {
            callback(new ArchiveValidationError("ARCHIVE_SIZE_EXCEEDED"));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      const destination = new PassThrough();
      const stored = input.putFile({
        body: destination,
        mimeType: mimeForPath(path),
        path,
        size: entry.uncompressedSize,
      });
      await pipeline(source, meter, destination);
      await stored;
      if (written !== entry.uncompressedSize)
        throw new ArchiveValidationError("ARCHIVE_SIZE_MISMATCH");
      totalSize += written;
      files.push({
        contentHash: hash.digest("hex"),
        mimeType: mimeForPath(path),
        path,
        size: written,
      });
    }
  } catch (error) {
    if (error instanceof ArchiveValidationError) throw error;
    throw new ArchiveValidationError("ARCHIVE_INVALID");
  } finally {
    zip.close();
  }
  if (files.length !== input.entries.length)
    throw new ArchiveValidationError("ARCHIVE_ENTRY_COUNT_MISMATCH");
  return { files, manifestDigest: digestFiles(files), totalSize };
}

export function digestFiles(
  files: readonly Pick<ExtractedFile, "path" | "size" | "contentHash">[],
) {
  const canonical = [...files]
    .sort((left, right) => left.path.localeCompare(right.path, "en"))
    .map((file) => `${file.path}\u0000${file.size}\u0000${file.contentHash}\n`)
    .join("");
  return createHash("sha256").update(canonical).digest("hex");
}

function normalizeArchivePath(path: string) {
  try {
    return normalizeRelativePath(path);
  } catch {
    throw new ArchiveValidationError("ARCHIVE_PATH_INVALID");
  }
}

function isDirectory(entry: yauzl.Entry) {
  return entry.fileName.endsWith("/");
}

function isSymlink(entry: yauzl.Entry) {
  const unixMode = entry.externalFileAttributes >>> 16;
  return (unixMode & 0o170000) === 0o120000;
}

function mimeForPath(path: string) {
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
    png: "image/png",
    svg: "image/svg+xml",
    webp: "image/webp",
  };
  return extension === undefined
    ? "application/octet-stream"
    : (known[extension] ?? "application/octet-stream");
}
