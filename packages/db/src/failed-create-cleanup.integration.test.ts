import { randomUUID } from "node:crypto";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { UPLOAD_IDEMPOTENCY_TTL_MS } from "@html-share/core";

import { createPrismaClient } from "./auth-repository.js";
import { createCleanupRepository } from "./cleanup-repository.js";
import { UploadTaskStatus } from "./generated/prisma/client.js";
import { UPLOAD_CLEANUP_GRACE_MS } from "./upload-repository-maintenance.js";
import { createUploadRepository } from "./upload-repository.js";

const databaseUrl = process.env["PHASE9_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

describeDatabase("failed create metadata retention", () => {
  const prisma = databaseUrl === undefined ? null : createPrismaClient(databaseUrl);
  const tenantIds: string[] = [];
  const cleanupTargetIds: string[][] = [];

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (prisma === null) return;
    const tenantId = tenantIds.pop();
    if (tenantId === undefined) return;
    await prisma.cleanupJob.deleteMany({
      where: { targetId: { in: cleanupTargetIds.pop() ?? [] } },
    });
    await prisma.demoProject.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  });

  it("reuses the reserved project for a retry during the 24-hour idempotency window", async () => {
    if (prisma === null) throw new Error("PHASE9_DATABASE_URL is required");
    const fixture = await createOwner(prisma);
    tenantIds.push(fixture.tenantId);
    const repository = createUploadRepository(prisma);
    const now = new Date();
    const clientRequestId = randomUUID();
    const first = await repository.prepare(prepareInput(fixture.owner, clientRequestId, now));
    const firstTask = await prisma.uploadTask.findUniqueOrThrow({ where: { id: first.uploadId } });
    cleanupTargetIds.push([firstTask.projectId, firstTask.revisionId, firstTask.id]);
    await repository.failUpload({
      failureCode: "UPLOAD_OBJECT_MISSING",
      now,
      uploadId: first.uploadId,
    });

    const retried = await repository.prepare(
      prepareInput(fixture.owner, clientRequestId, new Date(now.getTime() + 10 * 60 * 1000)),
    );
    const retriedTask = await prisma.uploadTask.findUniqueOrThrow({
      where: { id: retried.uploadId },
    });
    cleanupTargetIds.at(-1)?.push(retriedTask.revisionId, retriedTask.id);

    expect(retried.idempotent).toBe(false);
    expect(retried.projectId).toBe(first.projectId);
    expect(retried.uploadId).not.toBe(first.uploadId);
    expect(retried.revisionNumber).toBe(2);
  });

  it("cleans objects after expiry, retains idempotency metadata, then removes an empty pending project", async () => {
    if (prisma === null) throw new Error("PHASE9_DATABASE_URL is required");
    const fixture = await createOwner(prisma);
    tenantIds.push(fixture.tenantId);
    const repository = createUploadRepository(prisma);
    const cleanup = createCleanupRepository(prisma);
    const now = new Date();
    const prepared = await repository.prepare(prepareInput(fixture.owner, randomUUID(), now));
    await repository.failUpload({
      failureCode: "UPLOAD_OBJECT_MISSING",
      now,
      uploadId: prepared.uploadId,
    });
    const task = await prisma.uploadTask.findUniqueOrThrow({ where: { id: prepared.uploadId } });
    const targets = [task.projectId, task.revisionId, task.id];
    cleanupTargetIds.push(targets);
    const firstCleanupAt = new Date(task.expiresAt.getTime() + UPLOAD_CLEANUP_GRACE_MS);
    await cleanup.enqueueDueCleanupJobs(firstCleanupAt);
    await completeAllClaimed(cleanup, firstCleanupAt);

    await expect(
      prisma.uploadTask.findUniqueOrThrow({ where: { id: task.id } }),
    ).resolves.toMatchObject({
      status: UploadTaskStatus.FAILED,
      temporaryCleanedAt: firstCleanupAt,
    });
    await expect(
      prisma.demoProject.findUniqueOrThrow({ where: { projectKey: prepared.projectId } }),
    ).resolves.toMatchObject({ status: "PENDING" });

    const retentionAt = new Date(task.createdAt.getTime() + UPLOAD_IDEMPOTENCY_TTL_MS);
    await cleanup.enqueueDueCleanupJobs(retentionAt);
    const revisionJob = await prisma.cleanupJob.findUniqueOrThrow({
      where: { kind_targetId: { kind: "REVISION", targetId: task.revisionId } },
    });
    await prisma.cleanupJob.update({
      data: { status: "RUNNING" },
      where: { id: revisionJob.id },
    });
    await cleanup.completeCleanupJob({
      id: revisionJob.id,
      kind: "revision",
      now: retentionAt,
    });

    await expect(prisma.uploadTask.findUnique({ where: { id: task.id } })).resolves.toBeNull();
    await expect(
      prisma.demoProject.findUnique({ where: { projectKey: prepared.projectId } }),
    ).resolves.toBeNull();

    const reusedProject = await prisma.demoProject.create({
      data: {
        displayName: "Reused public key",
        ownerUserId: fixture.owner.id,
        projectKey: prepared.projectId,
        tenantId: fixture.tenantId,
      },
    });
    const replacement = await repository.prepare({
      ...prepareInput(fixture.owner, randomUUID(), new Date(retentionAt.getTime() + 1)),
      action: "replace",
      projectId: prepared.projectId,
    });
    const replacementTask = await prisma.uploadTask.findUniqueOrThrow({
      where: { id: replacement.uploadId },
    });
    targets.push(reusedProject.id, replacementTask.revisionId, replacementTask.id);
    expect(replacement.files[0]?.storageKey).not.toBe(prepared.files[0]?.storageKey);
    expect(replacement.files[0]?.storageKey).toContain(reusedProject.id);
  });
});

type TestPrisma = NonNullable<ReturnType<typeof createPrismaClient>>;

async function createOwner(prisma: TestPrisma) {
  const suffix = randomUUID().replaceAll("-", "");
  const tenant = await prisma.tenant.create({
    data: { dingtalkAppKeyRef: `failed-create-${suffix}`, name: "Failed create" },
  });
  const owner = await prisma.user.create({
    data: {
      dingtalkUserId: `failed-create-${suffix}`,
      displayName: "Failed create owner",
      lastLoginAt: new Date(),
      tenantId: tenant.id,
    },
  });
  return { owner, tenantId: tenant.id };
}

function prepareInput(
  owner: Awaited<ReturnType<typeof createOwner>>["owner"],
  clientRequestId: string,
  now: Date,
) {
  return {
    action: "create" as const,
    clientRequestId,
    displayName: "Failed create",
    fileCount: 1,
    files: [
      {
        contentMd5: "ndTkYSaMgDT1yFZOFVxnpg==",
        mimeType: "text/html; charset=utf-8",
        relativePath: "index.html",
        sha256: "a".repeat(64),
        size: 1,
      },
    ],
    manifestDigest: "b".repeat(64),
    now,
    owner,
    targetHtml: "index.html",
    totalSize: 1,
  };
}

async function completeAllClaimed(cleanup: ReturnType<typeof createCleanupRepository>, now: Date) {
  while (true) {
    const job = await cleanup.claimNextCleanupJob(now);
    if (job === null) return;
    await cleanup.completeCleanupJob({ id: job.id, kind: job.kind, now });
  }
}
