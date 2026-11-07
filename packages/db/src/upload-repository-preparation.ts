import { randomUUID } from "node:crypto";

import {
  MAX_DEMOS_PER_USER,
  MAX_STORAGE_BYTES_PER_USER,
  UPLOAD_IDEMPOTENCY_TTL_MS,
  UPLOAD_URL_TTL_MS,
  type PreparedUpload,
  type UploadRepository,
  UploadError,
} from "@html-share/core";

import {
  DemoProjectStatus,
  QuotaReservationStatus,
  UploadAction,
  UploadTaskStatus,
  type PrismaClient,
} from "./generated/prisma/client.js";
import { expireUploadTasks } from "./upload-repository-maintenance.js";

import {
  assertSameUploadRequest,
  generatePasswordCandidate,
  pendingPasswordData,
} from "./password-upload-policy.js";

import type { UploadRepositoryOptions } from "./upload-repository.js";

type Transaction = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
type PrepareInput = Parameters<UploadRepository["prepare"]>[0];

export async function prepareUpload(
  prisma: PrismaClient,
  input: PrepareInput,
  {
    passwordCrypto: crypto,
    passwordManagementCrypto: managementCrypto,
    maxDemosPerUser = MAX_DEMOS_PER_USER,
  }: UploadRepositoryOptions,
) {
  // Expiry must commit before this request can acquire any project lock.
  await prisma.$transaction((tx) => expireUploadTasks(tx, input.now));
  const candidate = await generatePasswordCandidate(input, crypto);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.owner.id}))`;
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
      // Failed/expired creates released their reservation. Reusing the pending
      // project must reserve quota again under the same owner advisory lock.
      if (input.action === "create")
        await assertCreateQuota(tx, input.owner.id, input.totalSize, input.now, maxDemosPerUser);
      const project =
        input.action === "replace"
          ? await findOwnedProject(tx, requiredProjectId(input.projectId), input.owner.id)
          : existing?.status === UploadTaskStatus.EXPIRED ||
              existing?.status === UploadTaskStatus.FAILED
            ? await findOwnedProject(tx, existing.project.projectKey, input.owner.id)
            : await createReservedProject(tx, input.owner.id, input.displayName);
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
      return toPrepared(task, project.projectKey, false, "prepared");
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new UploadError("PROJECT_UPLOAD_CONFLICT");
    throw error;
  }
}

async function createReservedProject(tx: Transaction, ownerUserId: string, displayName: string) {
  const owner = await tx.user.findUniqueOrThrow({
    where: { id: ownerUserId },
    select: { tenantId: true },
  });
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

async function assertCreateQuota(
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

async function findOwnedProject(tx: Transaction, projectKey: string, ownerUserId: string) {
  const projects = await tx.$queryRaw<LockedOwnedProject[]>`
    SELECT
      "id",
      "tenant_id" AS "tenantId",
      "owner_user_id" AS "ownerUserId",
      "project_key" AS "projectKey",
      "status",
      "access_mode" AS "accessMode",
      "password_hash" AS "passwordHash",
      "password_version" AS "passwordVersion"
    FROM "demo_projects"
    WHERE "project_key" = ${projectKey}
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

function createProjectKey() {
  return randomUUID().replaceAll("-", "").slice(0, 5);
}

function requiredProjectId(value: string | undefined) {
  if (value === undefined) throw new UploadError("INVALID_UPLOAD_INPUT");
  return value;
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}
