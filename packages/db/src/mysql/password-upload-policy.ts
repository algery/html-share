import type { MysqlTransactionClient } from "./types.js";
import {
  UPLOAD_IDEMPOTENCY_TTL_MS,
  UploadError,
  type DemoAccessMode,
  type UploadRepository,
  type UploadTaskSummary,
  type createPasswordCrypto,
  projectPasswordContext,
} from "@html-share/core";

type Transaction = MysqlTransactionClient;
type PrepareInput = Parameters<UploadRepository["prepare"]>[0];
export type PasswordCrypto = ReturnType<typeof createPasswordCrypto>;
export interface PasswordCandidate {
  password: string;
  hash: string;
}

export function passwordContext(
  taskId: string,
  ownerId: string,
  projectId: string,
  version: number,
) {
  return JSON.stringify([taskId, ownerId, projectId, version]);
}

export async function generatePasswordCandidate(input: PrepareInput, crypto?: PasswordCrypto) {
  if (input.accessMode !== "password" && input.regeneratePassword !== true) return undefined;
  if (crypto === undefined) throw new UploadError("INVALID_UPLOAD_INPUT");
  return crypto.generate();
}

export function pendingPasswordData(
  project: { id: string; accessMode: string; passwordHash: string | null; passwordVersion: number },
  input: PrepareInput,
  uploadId: string,
  candidate: PasswordCandidate | undefined,
  crypto: PasswordCrypto | undefined,
  managementCrypto: PasswordCrypto | undefined,
) {
  const mode =
    input.accessMode ?? (input.action === "create" ? "organization" : project.accessMode);
  if (input.regeneratePassword === true && mode !== "password")
    throw new UploadError("INVALID_UPLOAD_INPUT");
  const generate =
    mode === "password" && (project.accessMode !== "password" || input.regeneratePassword === true);
  const changed = generate || mode !== project.accessMode;
  const version = project.passwordVersion + (changed ? 1 : 0);
  let hash = mode === "organization" ? null : project.passwordHash;
  let encryptedPasswordResult: string | null = null;
  let pendingEncryptedPassword: string | null = null;
  if (generate) {
    if (candidate === undefined || crypto === undefined || managementCrypto === undefined)
      throw new UploadError("INVALID_UPLOAD_INPUT");
    hash = candidate.hash;
    encryptedPasswordResult = crypto.encrypt(
      candidate.password,
      passwordContext(uploadId, input.owner.id, project.id, version),
    );
    pendingEncryptedPassword = managementCrypto.encrypt(
      candidate.password,
      projectPasswordContext({
        id: project.id,
        ownerUserId: input.owner.id,
        passwordVersion: version,
      }),
    );
  }
  return {
    requestedAccessMode: input.accessMode ?? null,
    regeneratePassword: input.regeneratePassword ?? false,
    pendingAccessMode: mode,
    pendingPasswordHash: hash,
    pendingEncryptedPassword,
    pendingPasswordVersion: version,
    encryptedPasswordResult,
    passwordResultExpiresAt: generate
      ? new Date(input.now.getTime() + UPLOAD_IDEMPOTENCY_TTL_MS)
      : null,
  };
}

export function assertSameUploadRequest(
  existing: {
    action: string;
    requestedAccessMode: string | null;
    regeneratePassword: boolean;
    manifestDigest: string;
    displayName: string;
    targetHtml: string;
    riskAckDigest: string | null;
    project: { projectKey: string };
  },
  input: PrepareInput,
) {
  if (
    existing.action.toLowerCase() !== input.action ||
    (input.action === "replace" && existing.project.projectKey !== input.projectId) ||
    existing.manifestDigest !== input.manifestDigest ||
    existing.displayName !== input.displayName ||
    existing.targetHtml !== input.targetHtml ||
    existing.riskAckDigest !== (input.riskAckDigest ?? null) ||
    existing.requestedAccessMode !== (input.accessMode ?? null) ||
    existing.regeneratePassword !== (input.regeneratePassword ?? false)
  ) {
    throw new UploadError("INVALID_UPLOAD_INPUT");
  }
}

/** Called with the project publication lock already held. */
export async function publishPasswordData(
  tx: Transaction,
  task: {
    id: string;
    projectId: string;
    pendingAccessMode: string | null;
    pendingPasswordVersion: number | null;
    pendingPasswordHash: string | null;
    pendingEncryptedPassword: string | null;
  },
) {
  if (task.pendingAccessMode === null) return {};
  if (
    task.pendingPasswordVersion === null ||
    (task.pendingAccessMode === "password" && task.pendingPasswordHash === null)
  )
    throw new UploadError("INVALID_UPLOAD_INPUT");
  const project = await tx.demoProject.findUniqueOrThrow({ where: { id: task.projectId } });
  if (project.passwordVersion !== task.pendingPasswordVersion) {
    await tx.passwordAccessGrant.updateMany({
      where: { projectId: project.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.uploadTask.updateMany({
      where: { projectId: project.id, id: { not: task.id } },
      data: {
        encryptedPasswordResult: null,
        pendingEncryptedPassword: null,
        passwordResultExpiresAt: null,
        pendingPasswordHash: null,
      },
    });
  }
  return {
    accessMode: task.pendingAccessMode,
    encryptedPassword:
      task.pendingAccessMode === "organization"
        ? null
        : (task.pendingEncryptedPassword ?? project.encryptedPassword),
    passwordHash: task.pendingPasswordHash,
    passwordVersion: task.pendingPasswordVersion,
  };
}

export async function publishedAccessResult(
  tx: Transaction,
  taskId: string,
  ownerId: string,
  now: Date,
  crypto?: PasswordCrypto,
): Promise<Partial<UploadTaskSummary>> {
  const pointer = await tx.uploadTask.findFirst({
    where: { id: taskId, ownerUserId: ownerId },
    select: { projectId: true },
  });
  if (pointer === null) return {};
  // Serialize result retrieval with password replacement/deletion. Re-read task after locking.
  await tx.$queryRaw`SELECT id FROM demo_projects WHERE id = ${pointer.projectId} FOR SHARE`;
  const task = await tx.uploadTask.findFirst({
    where: { id: taskId, ownerUserId: ownerId, status: "COMPLETED" },
    select: {
      createdAt: true,
      encryptedPasswordResult: true,
      id: true,
      passwordResultExpiresAt: true,
      pendingAccessMode: true,
      pendingPasswordVersion: true,
      projectId: true,
      targetHtml: true,
      project: { select: { accessMode: true, passwordVersion: true, status: true } },
    },
  });
  if (task === null) return {};
  const mode = (task.pendingAccessMode ?? "organization") as DemoAccessMode;
  const result: Partial<UploadTaskSummary> = { accessMode: mode, targetHtml: task.targetHtml };
  if (mode !== "password") return result;
  const clock = await tx.$queryRaw<{ now: Date }[]>`SELECT CURRENT_TIMESTAMP(3) AS now`;
  const effectiveNow = Math.max(now.getTime(), clock[0]?.now.getTime() ?? now.getTime());
  const valid =
    task.project.status === "ACTIVE" &&
    task.project.accessMode === "password" &&
    task.pendingPasswordVersion === task.project.passwordVersion &&
    task.createdAt.getTime() + UPLOAD_IDEMPOTENCY_TTL_MS > effectiveNow;
  if (!valid || task.pendingPasswordVersion === null)
    return { ...result, passwordStatus: "unavailable" };
  if (task.encryptedPasswordResult === null) return { ...result, passwordStatus: "retained" };
  if (
    crypto === undefined ||
    task.passwordResultExpiresAt === null ||
    task.passwordResultExpiresAt.getTime() <= effectiveNow
  )
    return { ...result, passwordStatus: "unavailable" };
  return {
    ...result,
    passwordStatus: "generated",
    accessPassword: crypto.decrypt(
      task.encryptedPasswordResult,
      passwordContext(task.id, ownerId, task.projectId, task.pendingPasswordVersion),
    ),
  };
}
