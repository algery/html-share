import type { FastifyReply } from "fastify";

import type { PublishedDemoFile } from "@html-share/core";

const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function applyDemoResponsePolicy(reply: FastifyReply, file: PublishedDemoFile) {
  const etag = `"${file.contentHash}"`;
  return reply
    .header("cache-control", "private, max-age=0, must-revalidate")
    .header("content-length", String(file.size))
    .header("content-type", contentTypeForPath(file.relativePath))
    .header("etag", etag)
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("x-robots-tag", "noindex");
}

export function contentTypeForPath(path: string) {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot <= slash) return "application/octet-stream";
  return MIME_TYPES[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

export function matchesEtag(value: string | undefined, contentHash: string) {
  if (value === undefined) return false;
  const etag = `"${contentHash}"`;
  return value
    .split(",")
    .some((candidate) => candidate.trim() === "*" || candidate.trim() === etag);
}
