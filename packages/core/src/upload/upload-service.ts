import { randomUUID } from "node:crypto";

import type { PlatformUserIdentity } from "../auth/contracts.js";
import {
  MAX_DEMO_FILES,
  MAX_DEMO_TOTAL_BYTES,
  MAX_ZIP_ARCHIVE_BYTES,
  UPLOAD_URL_TTL_MS,
  type PrepareDemoUploadInput,
  type UploadRepository,
} from "./contracts.js";
import { UploadError } from "./contracts.js";

export interface UploadServiceOptions {
  repository: UploadRepository;
  now?: () => Date;
}

export function createUploadService(options: UploadServiceOptions) {
  const now = options.now ?? (() => new Date());
  return {
    async prepare(input: PrepareDemoUploadInput & { owner: PlatformUserIdentity }) {
      const normalized = normalizePrepareInput(input);
      return options.repository.prepare({ ...normalized, now: now(), owner: input.owner });
    },

    complete(input: { ownerUserId: string; uploadId: string }) {
      return options.repository.requestCompletion({ ...input, now: now() });
    },

    status(input: { ownerUserId: string; uploadId: string }) {
      return options.repository.getStatus({ ...input, now: now() });
    },
  };
}

export type UploadService = ReturnType<typeof createUploadService>;

function normalizePrepareInput(input: PrepareDemoUploadInput) {
  const displayName = input.displayName.trim();
  const targetHtml = normalizeRelativePath(input.targetHtml);
  if (
    (input.action !== "create" && input.action !== "replace") ||
    displayName.length < 1 ||
    displayName.length > 80 ||
    !Number.isInteger(input.fileCount) ||
    input.fileCount < 1 ||
    input.fileCount > MAX_DEMO_FILES ||
    !Number.isSafeInteger(input.totalSize) ||
    input.totalSize < 1 ||
    input.totalSize > MAX_DEMO_TOTAL_BYTES ||
    !Number.isSafeInteger(input.archiveSize) ||
    input.archiveSize < 1 ||
    input.archiveSize > MAX_ZIP_ARCHIVE_BYTES ||
    !/^[a-f0-9]{64}$/i.test(input.manifestDigest) ||
    (input.riskAckDigest !== undefined && !/^[a-f0-9]{64}$/i.test(input.riskAckDigest)) ||
    !isUuid(input.clientRequestId) ||
    !/\.html?$/i.test(targetHtml) ||
    (input.action === "create" && input.projectId !== undefined) ||
    (input.action === "replace" && !isProjectKey(input.projectId))
  ) {
    throw new UploadError("INVALID_UPLOAD_INPUT");
  }
  return {
    action: input.action,
    archiveSize: input.archiveSize,
    clientRequestId: input.clientRequestId,
    displayName,
    fileCount: input.fileCount,
    manifestDigest: input.manifestDigest.toLowerCase(),
    targetHtml,
    totalSize: input.totalSize,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId.toLowerCase() }),
    ...(input.riskAckDigest === undefined
      ? {}
      : { riskAckDigest: input.riskAckDigest.toLowerCase() }),
  };
}

export function createTemporaryObjectKey(uploadId = randomUUID()) {
  return `temporary/uploads/${uploadId}.zip`;
}

export function normalizeRelativePath(value: string) {
  if (value.length < 1 || value.length > 1024 || value.includes("\\") || value.includes("\u0000")) {
    throw new UploadError("INVALID_UPLOAD_INPUT");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new UploadError("INVALID_UPLOAD_INPUT");
  }
  return segments.join("/");
}

function isProjectKey(value: string | undefined): value is string {
  return value !== undefined && /^[a-z0-9]{5}$/.test(value);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export { UPLOAD_URL_TTL_MS };
