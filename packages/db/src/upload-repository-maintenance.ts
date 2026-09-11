import { type UploadTaskSummary } from "@html-share/core";

import {
  QuotaReservationStatus,
  RevisionStatus,
  UploadTaskStatus,
  type PrismaClient,
} from "./generated/prisma/client.js";

type Transaction = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

export const PROCESSING_LEASE_MS = 10 * 60 * 1000;
export const UPLOAD_CLEANUP_GRACE_MS = 60 * 1000;
export const FAILED_UPLOAD_METADATA_RETENTION_MS = 24 * 60 * 60 * 1000;

export async function expireUploadTasks(tx: Transaction, now: Date) {
  const tasks = await tx.uploadTask.findMany({
    select: { id: true },
    where: {
      OR: [
        { expiresAt: { lte: now }, status: UploadTaskStatus.PREPARED },
        {
          claimedAt: null,
          expiresAt: { lte: now },
          status: UploadTaskStatus.PROCESSING,
        },
        {
          claimedAt: { lte: new Date(now.getTime() - PROCESSING_LEASE_MS) },
          expiresAt: { lte: now },
          status: UploadTaskStatus.PROCESSING,
        },
      ],
    },
  });
  await Promise.all(tasks.map((task) => expireTask(tx, task.id, now)));
}

export async function expireTask(tx: Transaction, taskId: string, now: Date) {
  const expired = await tx.uploadTask.updateMany({
    data: { status: UploadTaskStatus.EXPIRED },
    where: {
      expiresAt: { lte: now },
      id: taskId,
      status: { in: [UploadTaskStatus.PREPARED, UploadTaskStatus.PROCESSING] },
    },
  });
  if (expired.count !== 1) return false;
  const task = await tx.uploadTask.findUniqueOrThrow({
    select: { createdAt: true, expiresAt: true, revisionId: true },
    where: { id: taskId },
  });
  await tx.revision.updateMany({
    data: {
      cleanupAfter: new Date(
        Math.max(
          now.getTime(),
          task.expiresAt.getTime() + UPLOAD_CLEANUP_GRACE_MS,
          task.createdAt.getTime() + FAILED_UPLOAD_METADATA_RETENTION_MS,
        ),
      ),
      failedAt: now,
      status: RevisionStatus.FAILED,
    },
    where: { id: task.revisionId, status: RevisionStatus.PENDING },
  });
  await tx.quotaReservation.updateMany({
    data: { releasedAt: now, status: QuotaReservationStatus.RELEASED },
    where: { status: QuotaReservationStatus.RESERVED, uploadTaskId: taskId },
  });
  return true;
}

export async function projectKey(tx: Transaction, projectId: string) {
  const project = await tx.demoProject.findUniqueOrThrow({
    where: { id: projectId },
    select: { projectKey: true },
  });
  return project.projectKey;
}

export function toTaskStatus(status: UploadTaskStatus): UploadTaskSummary["status"] {
  return status.toLowerCase() as UploadTaskSummary["status"];
}
