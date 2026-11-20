import { createHash } from "node:crypto";

import {
  capturePreparedCover,
  COVER_CAPTURE_CLEANUP_MS,
  COVER_CAPTURE_TIMEOUT_MS,
  MAX_COVER_BYTES,
} from "./capture-cover.mjs";
import { putPreparedBody } from "./direct-upload.mjs";
import { mcpCall } from "./mcp-client.mjs";

const COVER_UPLOAD_TIMEOUT_MS = 4_000;
const PUBLICATION_RESERVE_MS = 15_000;

export async function uploadOptionalCover(input, dependencies) {
  const homepage = input.prepared.cover_homepage;
  if (typeof homepage !== "string") return;
  const expiresAt = Date.parse(input.prepared.expires_at);
  const uploadBudget = Math.min(input.requestTimeoutMs, COVER_UPLOAD_TIMEOUT_MS);
  const coverDeadline = expiresAt - PUBLICATION_RESERVE_MS;
  if (
    !Number.isFinite(coverDeadline) ||
    coverDeadline - Date.now() < COVER_CAPTURE_TIMEOUT_MS + COVER_CAPTURE_CLEANUP_MS + uploadBudget
  ) {
    return;
  }
  if (
    !input.inspection.files.some(
      (file) => file.relative_path === homepage && file.mime_type.startsWith("text/html;"),
    )
  )
    return;
  try {
    const capture = dependencies.captureCover ?? capturePreparedCover;
    let captureTimer;
    const timeout = new Promise((resolve) => {
      captureTimer = setTimeout(resolve, COVER_CAPTURE_TIMEOUT_MS + COVER_CAPTURE_CLEANUP_MS);
    });
    const jpeg = await Promise.race([
      Promise.resolve().then(() => capture(input.inspection, input.prepared.project_id, homepage)),
      timeout,
    ]).finally(() => clearTimeout(captureTimer));
    if (
      !Buffer.isBuffer(jpeg) ||
      jpeg.length <= 2 ||
      jpeg.length > MAX_COVER_BYTES ||
      jpeg[0] !== 0xff ||
      jpeg[1] !== 0xd8
    ) {
      return;
    }

    const contentMd5 = createHash("md5").update(jpeg).digest("base64");
    const now = Date.now();
    const deadline = Math.min(now + uploadBudget, coverDeadline);
    if (deadline <= now) return;
    const signed = await mcpCall(
      dependencies.request,
      input.mcpUrl,
      input.token,
      5,
      "prepare_demo_cover",
      {
        upload_id: input.prepared.upload_id,
        homepage_path: homepage,
        size: jpeg.length,
        content_md5: contentMd5,
      },
      deadline - now,
    );
    if (!validSignature(signed, jpeg.length, contentMd5)) return;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || (await putPreparedBody(signed, jpeg, remaining, dependencies))) return;
    }
  } catch {
    // Cover generation/signing/upload is optional. Publish the already uploaded Demo.
  }
}

function validSignature(signed, size, contentMd5) {
  if (
    typeof signed.upload_url !== "string" ||
    signed.upload_headers === null ||
    typeof signed.upload_headers !== "object" ||
    Array.isArray(signed.upload_headers) ||
    Object.values(signed.upload_headers).some((value) => typeof value !== "string")
  ) {
    return false;
  }
  const url = new URL(signed.upload_url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    return false;
  }
  const headers = new globalThis.Headers(signed.upload_headers);
  return (
    headers.get("content-length") === String(size) &&
    headers.get("content-type") === "image/jpeg" &&
    headers.get("content-md5") === contentMd5
  );
}
