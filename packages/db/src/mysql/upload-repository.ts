import type { MysqlClient } from "./types.js";
import { mysqlTransaction } from "./transaction.js";
import { publishedAccessResult, type PasswordCrypto } from "./password-upload-policy.js";
import { type UploadRepository, type UploadTaskSummary, UploadError } from "@html-share/core";

import { UploadAction, UploadTaskStatus } from "../generated/prisma-mysql/client.js";
import {
  expireTask,
  expireUploadTasks,
  PROCESSING_LEASE_MS,
  projectKey,
  toTaskStatus,
} from "./upload-repository-maintenance.js";
import { prepareUpload } from "./upload-repository-preparation.js";
import {
  failUpload,
  markUploadFilesVerified,
  publishUpload,
} from "./upload-repository-publication.js";

export interface ProcessingUpload {
  uploadId: string;
  projectId: string;
  projectKey: string;
  revisionId: string;
  revisionNumber: number;
  ownerUserId: string;
  tenantId: string;
  targetHtml: string;
  traceId?: string;
  manifestDigest: string;
  declaredFileCount: number;
  declaredTotalSize: number;
  files: readonly {
    id: string;
    path: string;
    size: number;
    contentHash: string;
    contentMd5: string;
    mimeType: string;
    storageKey: string;
  }[];
  action: "create" | "replace";
}

export function createMysqlUploadRepository(
  prisma: MysqlClient,
  options: {
    passwordCrypto?: PasswordCrypto;
    passwordManagementCrypto?: PasswordCrypto;
  } = {},
): UploadRepository & {
  claimNextProcessingUpload(now: Date): Promise<ProcessingUpload | null>;
  publishUpload(input: { uploadId: string; now: Date }): Promise<boolean>;
  markUploadFilesVerified(input: { uploadId: string; now: Date }): Promise<void>;
  failUpload(input: { uploadId: string; failureCode: string; now: Date }): Promise<boolean>;
} {
  return {
    prepare: (input) =>
      prepareUpload(prisma, input, options.passwordCrypto, options.passwordManagementCrypto),

    async requestCompletion(input) {
      // Release unrelated expiry locks before taking the project lock for password results.
      await mysqlTransaction(prisma, (tx) => expireUploadTasks(tx, input.now));
      return mysqlTransaction(prisma, async (tx) => {
        const task = await tx.uploadTask.findFirst({
          where: { id: input.uploadId, ownerUserId: input.ownerUserId },
        });
        if (task === null) throw new UploadError("UPLOAD_NOT_FOUND");
        if (task.status === UploadTaskStatus.PREPARED && task.expiresAt <= input.now) {
          await expireTask(tx, task.id, input.now);
          return uploadSummary(task, await projectKey(tx, task.projectId), "expired");
        }
        let status = task.status;
        if (task.status === UploadTaskStatus.PREPARED) {
          const transitioned = await tx.uploadTask.updateMany({
            data: { status: UploadTaskStatus.PROCESSING },
            where: {
              expiresAt: { gt: input.now },
              id: task.id,
              ownerUserId: input.ownerUserId,
              status: UploadTaskStatus.PREPARED,
            },
          });
          status =
            transitioned.count === 1
              ? UploadTaskStatus.PROCESSING
              : (
                  await tx.uploadTask.findUniqueOrThrow({
                    select: { status: true },
                    where: { id: task.id },
                  })
                ).status;
        }
        return {
          ...uploadSummary(task, await projectKey(tx, task.projectId), toTaskStatus(status)),
          ...(status === UploadTaskStatus.COMPLETED
            ? await publishedAccessResult(
                tx,
                task.id,
                input.ownerUserId,
                input.now,
                options.passwordCrypto,
              )
            : {}),
        };
      });
    },

    async getStatus(input) {
      // Release unrelated expiry locks before taking the project lock for password results.
      await mysqlTransaction(prisma, (tx) => expireUploadTasks(tx, input.now));
      return mysqlTransaction(prisma, async (tx) => {
        const task = await tx.uploadTask.findFirst({
          where: { id: input.uploadId, ownerUserId: input.ownerUserId },
        });
        if (task === null) throw new UploadError("UPLOAD_NOT_FOUND");
        return {
          ...uploadSummary(task, await projectKey(tx, task.projectId), toTaskStatus(task.status)),
          ...(task.status === UploadTaskStatus.COMPLETED
            ? await publishedAccessResult(
                tx,
                task.id,
                input.ownerUserId,
                input.now,
                options.passwordCrypto,
              )
            : {}),
        };
      });
    },

    async claimNextProcessingUpload(now) {
      const task = await mysqlTransaction(prisma, async (tx) => {
        await expireUploadTasks(tx, now);
        const claimed = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM upload_tasks
          WHERE status = 'PROCESSING' AND expires_at > ${now}
            AND (claimed_at IS NULL OR claimed_at <= ${new Date(now.getTime() - PROCESSING_LEASE_MS)})
          ORDER BY created_at ASC, id ASC
          LIMIT 1 FOR UPDATE SKIP LOCKED
        `;
        const id = claimed[0]?.id;
        if (id === undefined) return null;
        await tx.uploadTask.update({ where: { id }, data: { claimedAt: now, updatedAt: now } });
        return tx.uploadTask.findUniqueOrThrow({
          include: { project: true, revision: true, uploadFiles: true },
          where: { id },
        });
      });
      if (task === null) return null;
      return {
        action: task.action === UploadAction.CREATE ? "create" : "replace",
        declaredFileCount: task.declaredFileCount,
        declaredTotalSize: Number(task.declaredTotalSize),
        manifestDigest: task.manifestDigest,
        ownerUserId: task.ownerUserId,
        projectId: task.projectId,
        projectKey: task.project.projectKey,
        revisionId: task.revisionId,
        revisionNumber: task.revision.revisionNumber,
        files: task.uploadFiles.map((file) => ({
          contentHash: file.expectedSha256,
          contentMd5: file.expectedContentMd5,
          id: file.id,
          mimeType: file.mimeType,
          path: file.relativePath,
          size: Number(file.expectedSize),
          storageKey: file.storageKey,
        })),
        targetHtml: task.targetHtml,
        tenantId: task.tenantId,
        ...(task.traceId === null ? {} : { traceId: task.traceId }),
        uploadId: task.id,
      };
    },

    publishUpload: (input) => publishUpload(prisma, input),

    markUploadFilesVerified: (input) => markUploadFilesVerified(prisma, input),

    failUpload: (input) => failUpload(prisma, input),
  };
}

function uploadSummary(
  task: { expiresAt: Date; id: string },
  projectId: string,
  status: UploadTaskSummary["status"],
): UploadTaskSummary {
  return { expiresAt: task.expiresAt, projectId, status, uploadId: task.id };
}
