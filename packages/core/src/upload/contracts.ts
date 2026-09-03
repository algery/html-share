import type { PlatformUserIdentity } from "../auth/contracts.js";

export const MAX_DEMO_FILES = 500;
export const MAX_DEMO_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_DEMO_TOTAL_BYTES = 20 * 1024 * 1024;
// Archive metadata is not published file content. Leave room for legal ZIP headers and filenames
// when the extracted content is exactly 20 MiB.
export const MAX_ZIP_ARCHIVE_BYTES = 22 * 1024 * 1024;
export const MAX_DEMOS_PER_USER = 100;
export const MAX_STORAGE_BYTES_PER_USER = 2 * 1024 * 1024 * 1024;
export const UPLOAD_URL_TTL_MS = 5 * 60 * 1000;
export const UPLOAD_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export type UploadAction = "create" | "replace";
export type UploadTaskStatus = "prepared" | "processing" | "completed" | "failed" | "expired";

export interface PrepareDemoUploadInput {
  action: UploadAction;
  projectId?: string;
  displayName: string;
  targetHtml: string;
  fileCount: number;
  totalSize: number;
  archiveSize: number;
  manifestDigest: string;
  riskAckDigest?: string;
  clientRequestId: string;
}

export interface PreparedUpload {
  uploadId: string;
  projectId: string;
  temporaryObjectKey: string;
  expiresAt: Date;
  archiveSize: number;
  idempotent: boolean;
  status: "prepared" | "processing" | "completed";
}

export interface UploadTaskSummary {
  uploadId: string;
  projectId: string;
  status: UploadTaskStatus;
  expiresAt: Date;
}

export interface UploadRepository {
  prepare(
    input: PrepareDemoUploadInput & { owner: PlatformUserIdentity; now: Date },
  ): Promise<PreparedUpload>;
  requestCompletion(input: {
    ownerUserId: string;
    uploadId: string;
    now: Date;
  }): Promise<UploadTaskSummary>;
  getStatus(input: {
    ownerUserId: string;
    uploadId: string;
    now: Date;
  }): Promise<UploadTaskSummary>;
}

export type UploadErrorCode =
  | "INVALID_UPLOAD_INPUT"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_FORBIDDEN"
  | "PROJECT_UPLOAD_CONFLICT"
  | "PROJECT_QUOTA_EXCEEDED"
  | "STORAGE_QUOTA_EXCEEDED"
  | "UPLOAD_RATE_LIMITED"
  | "UPLOAD_EXPIRED"
  | "UPLOAD_NOT_FOUND";

export class UploadError extends Error {
  constructor(readonly code: UploadErrorCode) {
    super(code);
    this.name = "UploadError";
  }
}
