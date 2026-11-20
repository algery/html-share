import type { PlatformUserIdentity } from "../auth/contracts.js";
import {
  MAX_DEMO_COVER_BYTES,
  UPLOAD_URL_TTL_MS,
  type PrepareDemoCoverInput,
  type PrepareDemoUploadInput,
  type UploadRepository,
} from "./contracts.js";
import { UploadError } from "./contracts.js";
import { normalizeRelativePath, validateManifest } from "./manifest-validator.js";

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

    async prepareCover(input: PrepareDemoCoverInput) {
      const homepagePath = normalizeRelativePath(input.homepagePath);
      if (
        !isUuid(input.uploadId) ||
        !/\.html?$/i.test(homepagePath) ||
        !Number.isInteger(input.size) ||
        input.size < 1 ||
        input.size > MAX_DEMO_COVER_BYTES ||
        !/^[A-Za-z0-9+/]{21}[AQgw]==$/.test(input.contentMd5)
      ) {
        throw new UploadError("INVALID_UPLOAD_INPUT");
      }
      return options.repository.prepareCover({ ...input, homepagePath, now: now() });
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
  const manifest = validateManifest({
    files: input.files,
    manifestDigest: input.manifestDigest,
    targetHtml,
  });
  if (
    (input.action !== "create" && input.action !== "replace") ||
    (input.accessMode !== undefined &&
      input.accessMode !== "organization" &&
      input.accessMode !== "password") ||
    (input.regeneratePassword !== undefined && typeof input.regeneratePassword !== "boolean") ||
    (input.regeneratePassword === true &&
      (input.action !== "replace" || input.accessMode === "organization")) ||
    displayName.length < 1 ||
    displayName.length > 80 ||
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
    ...(input.accessMode === undefined ? {} : { accessMode: input.accessMode }),
    ...(input.regeneratePassword === undefined
      ? {}
      : { regeneratePassword: input.regeneratePassword }),
    clientRequestId: input.clientRequestId,
    displayName,
    fileCount: manifest.files.length,
    files: manifest.files,
    manifestDigest: manifest.manifestDigest,
    targetHtml,
    totalSize: manifest.totalSize,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId.toLowerCase() }),
    ...(input.riskAckDigest === undefined
      ? {}
      : { riskAckDigest: input.riskAckDigest.toLowerCase() }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
  };
}

function isProjectKey(value: string | undefined): value is string {
  return value !== undefined && /^[a-z0-9]{5}$/.test(value);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export { UPLOAD_URL_TTL_MS };
