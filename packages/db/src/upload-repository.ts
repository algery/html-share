import { type UploadRepository, type UploadTaskSummary, UploadError } from "@html-share/core";

import {
  DemoProjectStatus,
  QuotaReservationStatus,
  RevisionStatus,
  UploadAction,
  UploadTaskStatus,
  type PrismaClient,
} from "./generated/prisma/client.js";
import {
  cleanupObjectKeysForTask,
  expireTask,
  expireUploadTasks,
  PROCESSING_LEASE_MS,
  projectKey,
  toTaskStatus,
} from "./upload-repository-maintenance.js";
import { prepareUpload } from "./upload-repository-preparation.js";

export interface ProcessingUpload {
  uploadId: string;
  projectId: string;
  projectKey: string;
  revisionId: string;
  revisionNumber: number;
  ownerUserId: string;
  tenantId: string;
  temporaryObjectKey: string;
  targetHtml: string;
  manifestDigest: string;
  declaredFileCount: number;
  declaredTotalSize: number;
  declaredArchiveSize: number;
  action: "create" | "replace";
}

export interface StoredFile {
  path: string;
  size: number;
  contentHash: string;
  mimeType: string;
  storageKey: string;
}

export function createUploadRepository(prisma: PrismaClient): UploadRepository & {
  claimNextProcessingUpload(now: Date): Promise<ProcessingUpload | null>;
  publishUpload(input: {
    uploadId: string;
    files: readonly StoredFile[];
    totalSize: number;
    now: Date;
  }): Promise<boolean>;
  failUpload(input: { uploadId: string; failureCode: string; now: Date }): Promise<void>;
  recordStagedObjectKey(input: { uploadId: string; storageKey: string }): Promise<void>;
  markTemporaryObjectsCleaned(input: { objectKeys: readonly string[]; now: Date }): Promise<void>;
  listCleanupObjectKeys(now: Date): Promise<string[]>;
} {
  return {
    prepare: (input) => prepareUpload(prisma, input),

    async requestCompletion(input) {
      return prisma.$transaction(async (tx) => {
        await expireUploadTasks(tx, input.now);
        const task = await tx.uploadTask.findFirst({
          where: { id: input.uploadId, ownerUserId: input.ownerUserId },
        });
        if (task === null) throw new UploadError("UPLOAD_NOT_FOUND");
        if (task.status === UploadTaskStatus.PREPARED && task.expiresAt <= input.now) {
          await expireTask(tx, task.id, input.now);
          return uploadSummary(task, await projectKey(tx, task.projectId), "expired");
        }
        if (task.status === UploadTaskStatus.PREPARED) {
          await tx.uploadTask.update({
            data: { status: UploadTaskStatus.PROCESSING },
            where: { id: task.id },
          });
        }
        return uploadSummary(
          task,
          await projectKey(tx, task.projectId),
          toTaskStatus(
            task.status === UploadTaskStatus.PREPARED ? UploadTaskStatus.PROCESSING : task.status,
          ),
        );
      });
    },

    async getStatus(input) {
      return prisma.$transaction(async (tx) => {
        await expireUploadTasks(tx, input.now);
        const task = await tx.uploadTask.findFirst({
          where: { id: input.uploadId, ownerUserId: input.ownerUserId },
        });
        if (task === null) throw new UploadError("UPLOAD_NOT_FOUND");
        return uploadSummary(task, await projectKey(tx, task.projectId), toTaskStatus(task.status));
      });
    },

    async claimNextProcessingUpload(now) {
      const task = await prisma.$transaction(async (tx) => {
        await expireUploadTasks(tx, now);
        const claimed = await tx.$queryRaw<{ id: string }[]>`
          WITH next_upload AS (
            SELECT "id"
            FROM "upload_tasks"
            WHERE "status" = 'PROCESSING'
              AND "expires_at" > ${now}
              AND (
                "claimed_at" IS NULL OR
                "claimed_at" <= ${new Date(now.getTime() - PROCESSING_LEASE_MS)}
              )
            ORDER BY "created_at" ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE "upload_tasks"
          SET "claimed_at" = ${now}, "updated_at" = ${now}
          FROM next_upload
          WHERE "upload_tasks"."id" = next_upload."id"
          RETURNING "upload_tasks"."id"
        `;
        const id = claimed[0]?.id;
        if (id === undefined) return null;
        return tx.uploadTask.findUniqueOrThrow({
          include: { project: true, revision: true },
          where: { id },
        });
      });
      if (task === null) return null;
      return {
        action: task.action === UploadAction.CREATE ? "create" : "replace",
        declaredArchiveSize: Number(task.declaredArchiveSize),
        declaredFileCount: task.declaredFileCount,
        declaredTotalSize: Number(task.declaredTotalSize),
        manifestDigest: task.manifestDigest,
        ownerUserId: task.ownerUserId,
        projectId: task.projectId,
        projectKey: task.project.projectKey,
        revisionId: task.revisionId,
        revisionNumber: task.revision.revisionNumber,
        temporaryObjectKey: task.temporaryObjectKey,
        targetHtml: task.targetHtml,
        tenantId: task.tenantId,
        uploadId: task.id,
      };
    },

    async publishUpload(input) {
      return prisma.$transaction(async (tx) => {
        const task = await tx.uploadTask.findUniqueOrThrow({
          include: { project: true },
          where: { id: input.uploadId },
        });
        if (task.status !== UploadTaskStatus.PROCESSING) return false;
        await tx.fileObject.createMany({
          data: input.files.map((file) => ({
            contentHash: file.contentHash,
            mimeType: file.mimeType,
            projectId: task.projectId,
            relativePath: file.path,
            revisionId: task.revisionId,
            size: BigInt(file.size),
            storageKey: file.storageKey,
            tenantId: task.tenantId,
          })),
        });
        await tx.revision.update({
          data: {
            fileCount: input.files.length,
            publishedAt: input.now,
            status: RevisionStatus.ACTIVE,
            totalSize: BigInt(input.totalSize),
          },
          where: { id: task.revisionId },
        });
        if (task.project.currentRevisionId !== null) {
          await tx.revision.update({
            data: {
              cleanupAfter: new Date(input.now.getTime() + 24 * 60 * 60 * 1000),
              status: RevisionStatus.OBSOLETE,
            },
            where: { id: task.project.currentRevisionId },
          });
        }
        await tx.demoProject.update({
          data: {
            currentRevisionId: task.revisionId,
            displayName: task.displayName,
            fileCount: input.files.length,
            status: DemoProjectStatus.ACTIVE,
            totalSize: BigInt(input.totalSize),
          },
          where: { id: task.projectId },
        });
        await tx.quotaReservation.update({
          data: { settledAt: input.now, status: QuotaReservationStatus.SETTLED },
          where: { uploadTaskId: task.id },
        });
        await tx.uploadTask.update({
          data: { completedAt: input.now, status: UploadTaskStatus.COMPLETED },
          where: { id: task.id },
        });
        return true;
      });
    },

    async failUpload(input) {
      await prisma.$transaction(async (tx) => {
        const task = await tx.uploadTask.findUnique({ where: { id: input.uploadId } });
        if (
          task === null ||
          task.status === UploadTaskStatus.COMPLETED ||
          task.status === UploadTaskStatus.FAILED
        )
          return;
        await tx.uploadTask.update({
          data: {
            failedAt: input.now,
            failureCode: input.failureCode,
            status: UploadTaskStatus.FAILED,
          },
          where: { id: task.id },
        });
        await tx.revision.update({
          data: { cleanupAfter: input.now, failedAt: input.now, status: RevisionStatus.FAILED },
          where: { id: task.revisionId },
        });
        await tx.quotaReservation.update({
          data: { releasedAt: input.now, status: QuotaReservationStatus.RELEASED },
          where: { uploadTaskId: task.id },
        });
      });
    },

    async recordStagedObjectKey(input) {
      await prisma.$executeRaw`
        UPDATE "upload_tasks"
        SET "staged_object_keys" = CASE
          WHEN "staged_object_keys" @> jsonb_build_array(${input.storageKey}::text)
            THEN "staged_object_keys"
          ELSE "staged_object_keys" || jsonb_build_array(${input.storageKey}::text)
        END
        WHERE "id" = ${input.uploadId}::uuid
          AND "status" = 'PROCESSING'
      `;
    },

    async markTemporaryObjectsCleaned(input) {
      await prisma.uploadTask.updateMany({
        data: { temporaryCleanedAt: input.now },
        where: { temporaryCleanedAt: null, temporaryObjectKey: { in: [...input.objectKeys] } },
      });
    },

    async listCleanupObjectKeys(now) {
      const [tasks, revisions] = await Promise.all([
        prisma.uploadTask.findMany({
          where: {
            status: {
              in: [UploadTaskStatus.COMPLETED, UploadTaskStatus.EXPIRED, UploadTaskStatus.FAILED],
            },
            temporaryCleanedAt: null,
            updatedAt: { lte: now },
          },
          select: { stagedObjectKeys: true, status: true, temporaryObjectKey: true },
        }),
        prisma.revision.findMany({
          include: { files: { select: { storageKey: true } } },
          where: {
            OR: [
              { status: RevisionStatus.FAILED },
              { cleanupAfter: { lte: now }, status: RevisionStatus.OBSOLETE },
            ],
          },
        }),
      ]);
      return [
        ...tasks.flatMap(cleanupObjectKeysForTask),
        ...revisions.flatMap((revision) => revision.files.map((file) => file.storageKey)),
      ];
    },
  };
}

function uploadSummary(
  task: { expiresAt: Date; id: string },
  projectId: string,
  status: UploadTaskSummary["status"],
): UploadTaskSummary {
  return { expiresAt: task.expiresAt, projectId, status, uploadId: task.id };
}

export { cleanupObjectKeysForTask } from "./upload-repository-maintenance.js";
