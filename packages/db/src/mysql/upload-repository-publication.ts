import type { MysqlClient } from "./types.js";
import { mysqlTransaction } from "./transaction.js";
import { publishPasswordData } from "./password-upload-policy.js";
import {
  DemoProjectStatus,
  QuotaReservationStatus,
  RevisionStatus,
  UploadFileVerificationStatus,
  UploadTaskStatus,
} from "../generated/prisma-mysql/client.js";
import {
  FAILED_UPLOAD_METADATA_RETENTION_MS,
  UPLOAD_CLEANUP_GRACE_MS,
} from "./upload-repository-maintenance.js";

export function publishUpload(prisma: MysqlClient, input: { uploadId: string; now: Date }) {
  return mysqlTransaction(prisma, async (tx) => {
    const taskPointer = await tx.uploadTask.findUnique({
      select: { projectId: true, ownerUserId: true },
      where: { id: input.uploadId },
    });
    if (taskPointer === null) return false;
    // Quota settlement uses the same owner lock as prepare, then project → task.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${taskPointer.ownerUserId} FOR UPDATE`;
    const lockedProject = await tx.$queryRaw<LockedProject[]>`
      SELECT status, owner_user_id AS ownerUserId, current_revision_id AS currentRevisionId
      FROM demo_projects
      WHERE id = ${taskPointer.projectId}
      FOR UPDATE
    `;
    const project = lockedProject[0];
    if (
      project === undefined ||
      project.status === DemoProjectStatus.DELETED ||
      project.ownerUserId !== taskPointer.ownerUserId
    )
      return false;
    const lockedTask = await tx.$queryRaw<LockedUploadTask[]>`
      SELECT status, owner_user_id AS ownerUserId, expires_at AS expiresAt, project_id AS projectId
      FROM upload_tasks
      WHERE id = ${input.uploadId}
      FOR UPDATE
    `;
    // A new statement evaluates database time after both lock waits complete.
    const databaseClock = await tx.$queryRaw<{ now: Date }[]>`
      SELECT CURRENT_TIMESTAMP(3) AS now
    `;
    const publicationNow = databaseClock[0]?.now;
    if (
      publicationNow === undefined ||
      lockedTask[0]?.status !== UploadTaskStatus.PROCESSING ||
      lockedTask[0].projectId !== taskPointer.projectId ||
      lockedTask[0].ownerUserId !== taskPointer.ownerUserId ||
      lockedTask[0].expiresAt <= publicationNow
    ) {
      return false;
    }
    const task = await tx.uploadTask.findUniqueOrThrow({
      include: { quotaReservation: true, revision: true, uploadFiles: true },
      where: { id: input.uploadId },
    });
    if (
      task.revision.status !== RevisionStatus.PENDING ||
      task.quotaReservation?.status !== QuotaReservationStatus.RESERVED ||
      task.uploadFiles.length !== task.declaredFileCount ||
      task.uploadFiles.some(
        (file) => file.verificationStatus !== UploadFileVerificationStatus.VERIFIED,
      )
    ) {
      return false;
    }
    const totalSize = task.uploadFiles.reduce(
      (total, file) => total + Number(file.expectedSize),
      0,
    );
    if (totalSize !== Number(task.declaredTotalSize)) return false;
    await tx.fileObject.createMany({
      data: task.uploadFiles.map((file) => ({
        contentHash: file.expectedSha256,
        mimeType: file.mimeType,
        projectId: task.projectId,
        relativePath: file.relativePath,
        revisionId: task.revisionId,
        size: file.expectedSize,
        storageKey: file.storageKey,
        tenantId: task.tenantId,
      })),
    });
    await tx.revision.update({
      data: {
        fileCount: task.uploadFiles.length,
        publishedAt: publicationNow,
        status: RevisionStatus.ACTIVE,
        totalSize: BigInt(totalSize),
      },
      where: { id: task.revisionId },
    });
    const currentRevisionId = project.currentRevisionId;
    if (currentRevisionId !== null) {
      await tx.revision.update({
        data: {
          cleanupAfter: new Date(publicationNow.getTime() + 24 * 60 * 60 * 1000),
          status: RevisionStatus.OBSOLETE,
        },
        where: { id: currentRevisionId },
      });
    }
    await tx.demoProject.update({
      data: {
        ...(await publishPasswordData(tx, task)),
        currentRevisionId: task.revisionId,
        displayName: task.displayName,
        fileCount: task.uploadFiles.length,
        status: DemoProjectStatus.ACTIVE,
        totalSize: BigInt(totalSize),
      },
      where: { id: task.projectId },
    });
    await tx.quotaReservation.update({
      data: { settledAt: publicationNow, status: QuotaReservationStatus.SETTLED },
      where: { uploadTaskId: task.id },
    });
    await tx.uploadTask.update({
      data: {
        completedAt: publicationNow,
        pendingEncryptedPassword: null,
        status: UploadTaskStatus.COMPLETED,
        temporaryCleanedAt: publicationNow,
      },
      where: { id: task.id },
    });
    return true;
  });
}

export async function markUploadFilesVerified(
  prisma: MysqlClient,
  input: { uploadId: string; now: Date },
) {
  await prisma.uploadFile.updateMany({
    data: { verificationStatus: UploadFileVerificationStatus.VERIFIED, verifiedAt: input.now },
    where: {
      uploadTaskId: input.uploadId,
      uploadTask: { status: UploadTaskStatus.PROCESSING },
    },
  });
}

export function failUpload(
  prisma: MysqlClient,
  input: { uploadId: string; failureCode: string; now: Date },
) {
  return mysqlTransaction(prisma, async (tx) => {
    const locked = await tx.$queryRaw<LockedFailureTask[]>`
      SELECT status, revision_id AS revisionId, expires_at AS expiresAt,
             created_at AS createdAt
      FROM upload_tasks
      WHERE id = ${input.uploadId}
      FOR UPDATE
    `;
    const task = locked[0];
    if (
      task === undefined ||
      (task.status !== UploadTaskStatus.PREPARED && task.status !== UploadTaskStatus.PROCESSING)
    ) {
      return false;
    }
    await tx.uploadTask.update({
      data: {
        encryptedPasswordResult: null,
        pendingEncryptedPassword: null,
        passwordResultExpiresAt: null,
        pendingPasswordHash: null,
        failedAt: input.now,
        failureCode: input.failureCode,
        status: UploadTaskStatus.FAILED,
      },
      where: { id: input.uploadId },
    });
    await tx.revision.update({
      data: {
        cleanupAfter: new Date(
          Math.max(
            input.now.getTime(),
            task.expiresAt.getTime() + UPLOAD_CLEANUP_GRACE_MS,
            task.createdAt.getTime() + FAILED_UPLOAD_METADATA_RETENTION_MS,
          ),
        ),
        failedAt: input.now,
        status: RevisionStatus.FAILED,
      },
      where: { id: task.revisionId },
    });
    await tx.quotaReservation.update({
      data: { releasedAt: input.now, status: QuotaReservationStatus.RELEASED },
      where: { uploadTaskId: input.uploadId },
    });
    return true;
  });
}

interface LockedProject {
  ownerUserId: string;
  currentRevisionId: string | null;
  status: DemoProjectStatus;
}

interface LockedUploadTask {
  ownerUserId: string;
  expiresAt: Date;
  projectId: string;
  status: UploadTaskStatus;
}

interface LockedFailureTask {
  createdAt: Date;
  expiresAt: Date;
  revisionId: string;
  status: UploadTaskStatus;
}
