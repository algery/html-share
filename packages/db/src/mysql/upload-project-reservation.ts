import { randomUUID } from "node:crypto";
import { MAX_STORAGE_BYTES_PER_USER, UploadError } from "@html-share/core";
import {
  DemoProjectStatus,
  QuotaReservationStatus,
  UploadTaskStatus,
} from "../generated/prisma-mysql/client.js";
import type { MysqlTransactionClient as Transaction } from "./types.js";
import { isDatabaseUniqueViolation as isUniqueViolation } from "../database-errors.js";

export async function createReservedProject(
  tx: Transaction,
  ownerUserId: string,
  displayName: string,
  requestedBytes: number,
  now: Date,
  maxDemosPerUser: number,
) {
  const owner = await tx.user.findUniqueOrThrow({
    where: { id: ownerUserId },
    select: { tenantId: true },
  });
  await assertCreateQuota(tx, ownerUserId, requestedBytes, now, maxDemosPerUser);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await tx.demoProject.create({
        data: {
          displayName,
          ownerUserId,
          projectKey: createProjectKey(),
          tenantId: owner.tenantId,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 9) throw error;
    }
  }
  throw new UploadError("PROJECT_UPLOAD_CONFLICT");
}

export async function findOwnedProject(tx: Transaction, projectKey: string, ownerUserId: string) {
  const projects = await tx.$queryRaw<LockedOwnedProject[]>`
    SELECT
      id,
      tenant_id AS tenantId,
      owner_user_id AS ownerUserId,
      project_key AS projectKey,
      status,
      access_mode AS accessMode,
      password_hash AS passwordHash,
      password_version AS passwordVersion
    FROM demo_projects
    WHERE project_key = ${projectKey}
    FOR UPDATE
  `;
  const project = projects[0];
  if (project === undefined || project.status === DemoProjectStatus.DELETED)
    throw new UploadError("PROJECT_NOT_FOUND");
  if (project.ownerUserId !== ownerUserId) throw new UploadError("PROJECT_FORBIDDEN");
  const active = await tx.uploadTask.findFirst({
    where: {
      projectId: project.id,
      status: { in: [UploadTaskStatus.PREPARED, UploadTaskStatus.PROCESSING] },
    },
  });
  if (active !== null) throw new UploadError("PROJECT_UPLOAD_CONFLICT");
  return project;
}

interface LockedOwnedProject {
  accessMode: string;
  passwordHash: string | null;
  passwordVersion: number;
  id: string;
  ownerUserId: string;
  projectKey: string;
  status: DemoProjectStatus;
  tenantId: string;
}

function createProjectKey() {
  return randomUUID().replaceAll("-", "").slice(0, 5);
}

export async function assertCreateQuota(
  tx: Transaction,
  ownerUserId: string,
  requestedBytes: number,
  now: Date,
  maxDemosPerUser: number,
) {
  const [activeCount, activeBytes, reservations] = await Promise.all([
    tx.demoProject.count({ where: { ownerUserId, status: DemoProjectStatus.ACTIVE } }),
    tx.demoProject.aggregate({
      _sum: { totalSize: true },
      where: { ownerUserId, status: DemoProjectStatus.ACTIVE },
    }),
    tx.quotaReservation.aggregate({
      _sum: { projectDelta: true, storageBytes: true },
      where: {
        expiresAt: { gt: now },
        status: QuotaReservationStatus.RESERVED,
        userId: ownerUserId,
      },
    }),
  ]);
  if (activeCount + (reservations._sum.projectDelta ?? 0) >= maxDemosPerUser)
    throw new UploadError("PROJECT_QUOTA_EXCEEDED");
  const usedBytes =
    Number(activeBytes._sum.totalSize ?? 0n) + Number(reservations._sum.storageBytes ?? 0n);
  if (usedBytes + requestedBytes > MAX_STORAGE_BYTES_PER_USER)
    throw new UploadError("STORAGE_QUOTA_EXCEEDED");
}
