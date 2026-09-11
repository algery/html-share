import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  DemoProjectStatus,
  QuotaReservationStatus,
  RevisionStatus,
  UploadTaskStatus,
} from "./generated/prisma/client.js";
import { createPrismaClient } from "./auth-repository.js";
import { createCleanupRepository } from "./cleanup-repository.js";
import { expireTask, UPLOAD_CLEANUP_GRACE_MS } from "./upload-repository-maintenance.js";
import { createUploadRepository } from "./upload-repository.js";
import {
  createPublicationRaceFixture,
  waitForDatabaseTime,
  waitForBlockedProjectLock,
} from "./upload-publication-race.test-helper.js";

const databaseUrl = process.env["PHASE9_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

describeDatabase("upload publication expiration fencing", () => {
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

  it("cannot activate a task that expires while publication waits for the project lock", async () => {
    if (prisma === null) throw new Error("PHASE9_DATABASE_URL is required");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);
    const fixture = await createPublicationRaceFixture(prisma, now, expiresAt);
    tenantIds.push(fixture.tenantId);
    cleanupTargetIds.push([fixture.projectId, fixture.revisionId, fixture.uploadId]);
    const repository = createUploadRepository(prisma);
    let releaseProjectLock: () => void = () => undefined;
    let announceProjectLock: () => void = () => undefined;
    const projectLocked = new Promise<void>((resolve) => {
      announceProjectLock = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseProjectLock = resolve;
    });
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "demo_projects"
          WHERE "id" = ${fixture.projectId}::uuid
          FOR UPDATE
        `;
        announceProjectLock();
        await release;
      },
      { timeout: 10_000 },
    );

    await projectLocked;
    const publishing = repository.publishUpload({ now, uploadId: fixture.uploadId });
    await waitForBlockedProjectLock(prisma);
    await prisma.$transaction((tx) => expireTask(tx, fixture.uploadId, expiresAt));
    releaseProjectLock();
    const [published] = await Promise.all([publishing, blocker.then(() => false)]);

    const [project, revision, task, reservation, files] = await Promise.all([
      prisma.demoProject.findUniqueOrThrow({ where: { id: fixture.projectId } }),
      prisma.revision.findUniqueOrThrow({ where: { id: fixture.revisionId } }),
      prisma.uploadTask.findUniqueOrThrow({ where: { id: fixture.uploadId } }),
      prisma.quotaReservation.findUniqueOrThrow({ where: { uploadTaskId: fixture.uploadId } }),
      prisma.fileObject.findMany({ where: { revisionId: fixture.revisionId } }),
    ]);
    expect(published).toBe(false);
    expect(project.currentRevisionId).toBe(fixture.oldRevisionId);
    expect(task.status).toBe(UploadTaskStatus.EXPIRED);
    expect(revision.status).toBe(RevisionStatus.FAILED);
    expect(reservation.status).toBe(QuotaReservationStatus.RELEASED);
    expect(files).toEqual([]);
    const cleanup = createCleanupRepository(prisma);
    await cleanup.enqueueDueCleanupJobs(
      new Date(expiresAt.getTime() + UPLOAD_CLEANUP_GRACE_MS - 1),
    );
    await expect(
      prisma.cleanupJob.findUnique({
        where: { kind_targetId: { kind: "UPLOAD", targetId: fixture.uploadId } },
      }),
    ).resolves.toBeNull();
    const firstSweepAt = new Date(expiresAt.getTime() + UPLOAD_CLEANUP_GRACE_MS);
    await cleanup.enqueueDueCleanupJobs(firstSweepAt);
    const cleanupJob = await prisma.cleanupJob.findUniqueOrThrow({
      where: { kind_targetId: { kind: "UPLOAD", targetId: fixture.uploadId } },
    });
    expect(cleanupJob).toMatchObject({ objectKeys: [fixture.newStorageKey] });
    await prisma.cleanupJob.update({
      data: { attemptCount: 1, status: "RUNNING" },
      where: { id: cleanupJob.id },
    });
    await cleanup.completeCleanupJob({ id: cleanupJob.id, kind: "upload", now: firstSweepAt });
    await expect(
      prisma.uploadTask.findUniqueOrThrow({ where: { id: fixture.uploadId } }),
    ).resolves.toMatchObject({ temporaryCleanedAt: firstSweepAt });
    await expect(
      prisma.cleanupJob.findUniqueOrThrow({ where: { id: cleanupJob.id } }),
    ).resolves.toMatchObject({
      completedAt: firstSweepAt,
      objectKeys: [fixture.newStorageKey],
      status: "COMPLETED",
    });
  }, 10_000);

  it("uses lock-time database time and cannot publish after expiry", async () => {
    if (prisma === null) throw new Error("PHASE9_DATABASE_URL is required");
    const clock = await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    const now = clock[0]?.now;
    if (now === undefined) throw new Error("database clock missing");
    const expiresAt = new Date(now.getTime() + 250);
    const fixture = await createPublicationRaceFixture(prisma, now, expiresAt);
    tenantIds.push(fixture.tenantId);
    cleanupTargetIds.push([fixture.projectId, fixture.revisionId, fixture.uploadId]);
    let releaseProjectLock: () => void = () => undefined;
    let announceProjectLock: () => void = () => undefined;
    const projectLocked = new Promise<void>((resolve) => {
      announceProjectLock = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseProjectLock = resolve;
    });
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "demo_projects"
          WHERE "id" = ${fixture.projectId}::uuid
          FOR UPDATE
        `;
        announceProjectLock();
        await release;
      },
      { timeout: 10_000 },
    );

    await projectLocked;
    const publishing = createUploadRepository(prisma).publishUpload({
      now,
      uploadId: fixture.uploadId,
    });
    // Attach both rejection handlers before waiting; always release the test lock.
    const settled = Promise.allSettled([publishing, blocker]);
    try {
      await waitForBlockedProjectLock(prisma);
      await waitForDatabaseTime(prisma, expiresAt);
    } finally {
      releaseProjectLock();
      await settled;
    }
    expect(await settled).toEqual([
      { status: "fulfilled", value: false },
      { status: "fulfilled", value: undefined },
    ]);
    await expect(
      prisma.demoProject.findUniqueOrThrow({ where: { id: fixture.projectId } }),
    ).resolves.toMatchObject({ currentRevisionId: fixture.oldRevisionId });
    await expect(
      prisma.uploadTask.findUniqueOrThrow({ where: { id: fixture.uploadId } }),
    ).resolves.toMatchObject({ status: UploadTaskStatus.PROCESSING });
  }, 10_000);

  it("cannot prepare a replacement after deletion has locked and tombstoned the project", async () => {
    if (prisma === null) throw new Error("PHASE9_DATABASE_URL is required");
    const now = new Date();
    const fixture = await createPublicationRaceFixture(
      prisma,
      now,
      new Date(now.getTime() + 300_000),
    );
    tenantIds.push(fixture.tenantId);
    cleanupTargetIds.push([fixture.projectId, fixture.revisionId, fixture.uploadId]);
    await prisma.uploadTask.delete({ where: { id: fixture.uploadId } });
    await prisma.revision.delete({ where: { id: fixture.revisionId } });
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: fixture.ownerId } });
    let releaseProjectLock: () => void = () => undefined;
    let announceProjectLock: () => void = () => undefined;
    const projectLocked = new Promise<void>((resolve) => {
      announceProjectLock = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseProjectLock = resolve;
    });
    const deleting = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "demo_projects"
          WHERE "id" = ${fixture.projectId}::uuid
          FOR UPDATE
        `;
        announceProjectLock();
        await release;
        await tx.demoProject.update({
          data: { status: DemoProjectStatus.DELETED },
          where: { id: fixture.projectId },
        });
      },
      { timeout: 10_000 },
    );
    await projectLocked;
    const preparing = createUploadRepository(prisma).prepare({
      action: "replace",
      clientRequestId: randomUUID(),
      displayName: "Must not resurrect",
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
      projectId: fixture.projectKey,
      targetHtml: "index.html",
      totalSize: 1,
    });
    await waitForBlockedProjectLock(prisma);
    releaseProjectLock();
    await deleting;

    await expect(preparing).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(
      prisma.uploadTask.count({ where: { projectId: fixture.projectId } }),
    ).resolves.toBe(0);
  }, 10_000);
});
