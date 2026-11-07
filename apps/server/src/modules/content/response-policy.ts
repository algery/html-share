import type { FastifyReply } from "fastify";

import { contentTypeForPath, type PublishedDemoFile } from "@html-share/core";

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

export function matchesEtag(value: string | undefined, contentHash: string) {
  if (value === undefined) return false;
  const etag = `"${contentHash}"`;
  return value
    .split(",")
    .some((candidate) => candidate.trim() === "*" || candidate.trim() === etag);
}
