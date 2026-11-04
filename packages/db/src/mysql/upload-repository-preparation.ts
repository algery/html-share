import {
  assertCreateQuota,
  createReservedProject,
  findOwnedProject,
} from "./upload-project-reservation.js";
import { isDatabaseUniqueViolation as isUniqueViolation } from "../database-errors.js";
import { assertManifestIdentity, assertStoredUploadFiles } from "./upload-path-identity.js";
import type { MysqlClient } from "./types.js";
import { mysqlTransaction } from "./transaction.js";
import { randomUUID } from "node:crypto";

import {
  UPLOAD_IDEMPOTENCY_TTL_MS,
  UPLOAD_URL_TTL_MS,
  type PreparedUpload,
  type UploadRepository,
  UploadError,
} from "@html-share/core";

import { UploadAction, UploadTaskStatus } from "../generated/prisma-mysql/client.js";
import { expireUploadTasks } from "./upload-repository-maintenance.js";

import {
  assertSameUploadRequest,
  generatePasswordCandidate,
  pendingPasswordData,
  type PasswordCrypto,
} from "./password-upload-policy.js";

type PrepareInput = Parameters<UploadRepository["prepare"]>[0];

export async function prepareUpload(
  prisma: MysqlClient,
  input: PrepareInput,
  crypto?: PasswordCrypto,
  managementCrypto?: PasswordCrypto,
) {
  // Expiry must commit before this request can acquire any project lock.
  await mysqlTransaction(prisma, (tx) => expireUploadTasks(tx, input.now));
  assertManifestIdentity(input.files);
  const candidate = await generatePasswordCandidate(input, crypto);
  try {
    return await mysqlTransaction(prisma, async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${input.owner.id} FOR UPDATE`;
      const existing = await tx.uploadTask.findFirst({
        include: {
          project: { select: { projectKey: true } },
          revision: { select: { revisionNumber: true } },
          uploadFiles: true,
        },
        orderBy: { createdAt: "desc" },
        where: {
          clientRequestId: input.clientRequestId,
          createdAt: { gt: new Date(input.now.getTime() - UPLOAD_IDEMPOTENCY_TTL_MS) },
          ownerUserId: input.owner.id,
        },
      });
      if (existing !== null) assertSameUploadRequest(existing, input);
      if (existing?.status === UploadTaskStatus.COMPLETED)
        return toPrepared(existing, existing.project.projectKey, true, "completed");
      if (existing?.status === UploadTaskStatus.PROCESSING)
        return toPrepared(existing, existing.project.projectKey, true, "processing");
      if (
        existing !== null &&
        existing.status !== UploadTaskStatus.EXPIRED &&
        existing.status !== UploadTaskStatus.FAILED
      ) {
        return toPrepared(existing, existing.project.projectKey, true, "prepared");
      }
      const project =
        input.action === "replace"
          ? await findOwnedProject(tx, requiredProjectId(input.projectId), input.owner.id)
          : existing?.status === UploadTaskStatus.EXPIRED ||
              existing?.status === UploadTaskStatus.FAILED
            ? await findOwnedProject(tx, existing.project.projectKey, input.owner.id)
            : await createReservedProject(
                tx,
                input.owner.id,
                input.displayName,
                input.totalSize,
                input.now,
              );
      if (input.action === "create" && existing !== null)
        await assertCreateQuota(tx, input.owner.id, input.totalSize, input.now);
      const revisionNumber = await tx.revision.aggregate({
        _max: { revisionNumber: true },
        where: { projectId: project.id },
      });
      const revision = await tx.revision.create({
        data: {
          projectId: project.id,
          revisionNumber: (revisionNumber._max.revisionNumber ?? 0) + 1,
          tenantId: project.tenantId,
        },
      });
      const expiresAt = new Date(input.now.getTime() + UPLOAD_URL_TTL_MS);
      const uploadId = randomUUID();
      const task = await tx.uploadTask.create({
        include: { revision: { select: { revisionNumber: true } }, uploadFiles: true },
        data: {
          ...pendingPasswordData(project, input, uploadId, candidate, crypto, managementCrypto),
          createdAt: input.now,
          action: input.action === "create" ? UploadAction.CREATE : UploadAction.REPLACE,
          clientRequestId: input.clientRequestId,
          declaredFileCount: input.fileCount,
          declaredTotalSize: BigInt(input.totalSize),
          displayName: input.displayName,
          expiresAt,
          id: uploadId,
          manifestDigest: input.manifestDigest,
          ownerUserId: input.owner.id,
          projectId: project.id,
          revisionId: revision.id,
          riskAckDigest: input.riskAckDigest ?? null,
          targetHtml: input.targetHtml,
          tenantId: project.tenantId,
          traceId: input.traceId ?? null,
          uploadFiles: {
            create: input.files.map((file) => ({
              expectedContentMd5: file.contentMd5,
              expectedSha256: file.sha256,
              expectedSize: BigInt(file.size),
              mimeType: file.mimeType,
              relativePath: file.relativePath,
              revisionId: revision.id,
              storageKey: revisionStorageKey(project.id, revision.id, file.relativePath),
              tenantId: project.tenantId,
            })),
          },
        },
      });
      await tx.quotaReservation.create({
        data: {
          expiresAt,
          projectDelta: input.action === "create" ? 1 : 0,
          storageBytes: BigInt(input.action === "create" ? input.totalSize : 0),
          tenantId: project.tenantId,
          uploadTaskId: task.id,
          userId: input.owner.id,
        },
      });
      assertStoredUploadFiles(task.uploadFiles, input.files, project.id, revision.id);
      return toPrepared(task, project.projectKey, false, "prepared");
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new UploadError("PROJECT_UPLOAD_CONFLICT");
    throw error;
  }
}

function toPrepared(
  task: {
    id: string;
    expiresAt: Date;
    revision: { revisionNumber: number };
    uploadFiles: readonly {
      expectedContentMd5: string;
      expectedSha256: string;
      expectedSize: bigint;
      mimeType: string;
      relativePath: string;
      storageKey: string;
    }[];
  },
  projectId: string,
  idempotent: boolean,
  status: PreparedUpload["status"],
): PreparedUpload {
  return {
    expiresAt: task.expiresAt,
    files: task.uploadFiles.map((file) => ({
      contentMd5: file.expectedContentMd5,
      mimeType: file.mimeType,
      relativePath: file.relativePath,
      sha256: file.expectedSha256,
      size: Number(file.expectedSize),
      storageKey: file.storageKey,
    })),
    idempotent,
    projectId,
    revisionNumber: task.revision.revisionNumber,
    status,
    uploadId: task.id,
  };
}

function revisionStorageKey(projectId: string, revisionId: string, relativePath: string) {
  return `projects/${projectId}/revisions/${revisionId}/${relativePath}`;
}

function requiredProjectId(value: string | undefined) {
  if (value === undefined) throw new UploadError("INVALID_UPLOAD_INPUT");
  return value;
}
