import type { createPasswordCrypto } from "../access/password-crypto.js";
import {
  UPLOAD_IDEMPOTENCY_TTL_MS,
  type DemoAccessMode,
  type DemoCoverUpload,
  type PreparedUpload,
  type UploadRepository,
  type UploadTaskStatus,
  type UploadTaskSummary,
  UploadError,
} from "./contracts.js";

export type PasswordCrypto = ReturnType<typeof createPasswordCrypto>;
export type PrepareInput = Parameters<UploadRepository["prepare"]>[0];

export interface StoredProject {
  id: string;
  ownerUserId: string;
  totalSize: number;
  nextRevision: number;
  accessMode: DemoAccessMode;
  passwordHash: string | null;
  passwordVersion: number;
  active: boolean;
  deleted: boolean;
}

export interface StoredTask extends Omit<PreparedUpload, "status"> {
  coverUpload?: DemoCoverUpload;
  clientRequestId: string;
  requestFingerprint: string;
  ownerUserId: string;
  status: UploadTaskStatus;
  createdAt: Date;
  targetHtml: string;
  totalSize: number;
  accessMode: DemoAccessMode;
  passwordHash: string | null;
  passwordVersion: number;
  encryptedPasswordResult: string | null;
}

export function requestFingerprint(input: PrepareInput): string {
  return JSON.stringify([
    input.action,
    input.projectId ?? null,
    input.manifestDigest,
    input.displayName,
    input.targetHtml,
    input.riskAckDigest ?? null,
    input.accessMode ?? null,
    input.regeneratePassword ?? false,
  ]);
}

function passwordContext(
  task: Pick<StoredTask, "uploadId" | "ownerUserId" | "projectId" | "passwordVersion">,
) {
  return JSON.stringify([task.uploadId, task.ownerUserId, task.projectId, task.passwordVersion]);
}

export async function preparePassword(
  project: StoredProject,
  input: PrepareInput,
  uploadId: string,
  crypto?: PasswordCrypto,
) {
  const accessMode =
    input.accessMode ?? (input.action === "create" ? "organization" : project.accessMode);
  if (
    input.regeneratePassword === true &&
    (input.action !== "replace" || accessMode !== "password")
  )
    throw new UploadError("INVALID_UPLOAD_INPUT");
  const generate =
    accessMode === "password" &&
    (project.accessMode !== "password" || input.regeneratePassword === true);
  const passwordVersion =
    project.passwordVersion + (generate || accessMode !== project.accessMode ? 1 : 0);
  let passwordHash = accessMode === "organization" ? null : project.passwordHash;
  let encryptedPasswordResult: string | null = null;
  if (generate) {
    if (!crypto) throw new UploadError("INVALID_UPLOAD_INPUT");
    const candidate = await crypto.generate();
    passwordHash = candidate.hash;
    encryptedPasswordResult = crypto.encrypt(
      candidate.password,
      passwordContext({
        uploadId,
        ownerUserId: input.owner.id,
        projectId: project.id,
        passwordVersion,
      }),
    );
  }
  return { accessMode, passwordVersion, passwordHash, encryptedPasswordResult };
}

export function expireTask(task: StoredTask, now: Date) {
  if ((task.status === "prepared" || task.status === "processing") && task.expiresAt <= now) {
    task.status = "expired";
    task.passwordHash = null;
    task.encryptedPasswordResult = null;
  }
  if (task.createdAt.getTime() + UPLOAD_IDEMPOTENCY_TTL_MS <= now.getTime())
    task.encryptedPasswordResult = null;
}

export function taskSummary(
  task: StoredTask,
  project: StoredProject | undefined,
  now: Date,
  crypto?: PasswordCrypto,
): UploadTaskSummary {
  const result: UploadTaskSummary = {
    expiresAt: task.expiresAt,
    projectId: task.projectId,
    status: task.status,
    uploadId: task.uploadId,
  };
  if (task.status !== "completed") return result;
  result.accessMode = task.accessMode;
  result.targetHtml = task.targetHtml;
  if (task.accessMode !== "password") return result;
  const valid =
    project?.active &&
    !project.deleted &&
    project.accessMode === "password" &&
    task.passwordVersion === project.passwordVersion &&
    task.createdAt.getTime() + UPLOAD_IDEMPOTENCY_TTL_MS > now.getTime();
  if (!valid) return { ...result, passwordStatus: "unavailable" };
  if (!task.encryptedPasswordResult) return { ...result, passwordStatus: "retained" };
  if (!crypto) return { ...result, passwordStatus: "unavailable" };
  return {
    ...result,
    passwordStatus: "generated",
    accessPassword: crypto.decrypt(task.encryptedPasswordResult, passwordContext(task)),
  };
}

export function toPreparedUpload(task: StoredTask, idempotent: boolean): PreparedUpload {
  return {
    coverHomepage: task.coverHomepage ?? null,
    expiresAt: task.expiresAt,
    files: task.files,
    idempotent,
    projectId: task.projectId,
    revisionNumber: task.revisionNumber,
    status:
      task.status === "completed"
        ? "completed"
        : task.status === "processing"
          ? "processing"
          : "prepared",
    uploadId: task.uploadId,
  };
}
