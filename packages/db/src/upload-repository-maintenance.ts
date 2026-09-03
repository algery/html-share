import { type UploadTaskSummary } from "@html-share/core";

import {
  QuotaReservationStatus,
  RevisionStatus,
  UploadTaskStatus,
  type PrismaClient,
} from "./generated/prisma/client.js";

type Transaction = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

export const PROCESSING_LEASE_MS = 10 * 60 * 1000;

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
  const task = await tx.uploadTask.findUniqueOrThrow({
    select: { revisionId: true },
    where: { id: taskId },
  });
  await tx.uploadTask.update({ data: { status: UploadTaskStatus.EXPIRED }, where: { id: taskId } });
  await tx.revision.update({
    data: { cleanupAfter: now, failedAt: now, status: RevisionStatus.FAILED },
    where: { id: task.revisionId },
  });
  await tx.quotaReservation.update({
    data: { releasedAt: now, status: QuotaReservationStatus.RELEASED },
    where: { uploadTaskId: taskId },
  });
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

export function cleanupObjectKeysForTask(task: {
  status: UploadTaskStatus;
  temporaryObjectKey: string;
  stagedObjectKeys: unknown;
}) {
  return task.status === UploadTaskStatus.COMPLETED
    ? [task.temporaryObjectKey]
    : [task.temporaryObjectKey, ...readStagedObjectKeys(task.stagedObjectKeys)];
}

function readStagedObjectKeys(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
