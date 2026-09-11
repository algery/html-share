import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  DemoProjectStatus,
  QuotaReservationStatus,
  RevisionStatus,
  type PrismaClient,
  UploadAction,
  UploadFileVerificationStatus,
  UploadTaskStatus,
} from "./generated/prisma/client.js";
import { createPrismaClient } from "./auth-repository.js";
import { createUploadRepository } from "./upload-repository.js";

const databaseUrl = process.env["PHASE9_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

describeDatabase("upload repository transaction integration", () => {
  const prisma = databaseUrl === undefined ? null : createPrismaClient(databaseUrl);
  const tenantIds: string[] = [];

  afterEach(async () => {
    if (prisma === null) return;
    const tenantId = tenantIds.pop();
    if (tenantId === undefined) return;
    await prisma.demoProject.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  });

  it("rolls back writes made before an atomic revision switch fails", async () => {
    if (prisma === null) throw new Error("PHASE9_DATABASE_URL is required");
    const suffix = randomUUID();
    const now = new Date();
    const tenant = await prisma.tenant.create({
      data: { dingtalkAppKeyRef: `phase9-transaction-${suffix}`, name: "Phase 9 transaction" },
    });
    tenantIds.push(tenant.id);
    const owner = await prisma.user.create({
      data: {
        dingtalkUserId: `phase9-owner-${suffix}`,
        displayName: "Phase 9 owner",
        lastLoginAt: now,
        tenantId: tenant.id,
      },
    });
    const project = await prisma.demoProject.create({
      data: {
        displayName: "Existing demo",
        accessMode: "password",
        passwordHash: "test-existing-hash",
        passwordVersion: 1,
        ownerUserId: owner.id,
        projectKey: `p${suffix.replaceAll("-", "").slice(0, 4)}`,
        status: DemoProjectStatus.ACTIVE,
        tenantId: tenant.id,
      },
    });
    const oldRevision = await prisma.revision.create({
      data: {
        fileCount: 1,
        projectId: project.id,
        publishedAt: now,
        revisionNumber: 1,
        status: RevisionStatus.ACTIVE,
        tenantId: tenant.id,
        totalSize: 3n,
      },
    });
    await prisma.demoProject.update({
      data: { currentRevisionId: oldRevision.id },
      where: { id: project.id },
    });
    const replacement = await prisma.revision.create({
      data: { projectId: project.id, revisionNumber: 2, tenantId: tenant.id },
    });
    await prisma.demoProject.create({
      data: {
        currentRevisionId: replacement.id,
        displayName: "Constraint holder",
        ownerUserId: owner.id,
        projectKey: `q${suffix.replaceAll("-", "").slice(0, 4)}`,
        status: DemoProjectStatus.PENDING,
        tenantId: tenant.id,
      },
    });
    const oldGrant = await prisma.passwordAccessGrant.create({
      data: {
        tenantId: tenant.id,
        projectId: project.id,
        passwordVersion: 1,
        grantHash: randomUUID(),
        expiresAt: new Date(now.getTime() + 28_800_000),
      },
    });
    const upload = await prisma.uploadTask.create({
      data: {
        action: UploadAction.REPLACE,
        pendingAccessMode: "password",
        pendingPasswordHash: "test-replacement-hash",
        pendingPasswordVersion: 2,
        clientRequestId: randomUUID(),
        declaredFileCount: 1,
        declaredTotalSize: 3n,
        displayName: "Replacement demo",
        expiresAt: new Date(now.getTime() + 60_000),
        manifestDigest: "a".repeat(64),
        ownerUserId: owner.id,
        projectId: project.id,
        revisionId: replacement.id,
        status: UploadTaskStatus.PROCESSING,
        targetHtml: "index.html",
        tenantId: tenant.id,
        uploadFiles: {
          create: {
            expectedContentMd5: "kAFQmDzST7DWlj99KOF/cg==",
            expectedSha256: "b".repeat(64),
            expectedSize: 3n,
            mimeType: "text/html; charset=utf-8",
            relativePath: "index.html",
            revisionId: replacement.id,
            storageKey: `projects/${project.projectKey}/revisions/2/index.html`,
            tenantId: tenant.id,
            verificationStatus: UploadFileVerificationStatus.VERIFIED,
            verifiedAt: now,
          },
        },
      },
    });
    await prisma.quotaReservation.create({
      data: {
        expiresAt: new Date(now.getTime() + 60_000),
        projectDelta: 0,
        storageBytes: 0n,
        tenantId: tenant.id,
        uploadTaskId: upload.id,
        userId: owner.id,
      },
    });

    const repository = createUploadRepository(prisma);
    await expect(
      repository.publishUpload({
        now,
        uploadId: upload.id,
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    const [storedFiles, persistedProject, persistedReplacement, persistedTask, reservation] =
      await Promise.all([
        prisma.fileObject.findMany({ where: { revisionId: replacement.id } }),
        prisma.demoProject.findUniqueOrThrow({ where: { id: project.id } }),
        prisma.revision.findUniqueOrThrow({ where: { id: replacement.id } }),
        prisma.uploadTask.findUniqueOrThrow({ where: { id: upload.id } }),
        prisma.quotaReservation.findUniqueOrThrow({ where: { uploadTaskId: upload.id } }),
      ]);

    expect(storedFiles).toEqual([]);
    expect(persistedProject.currentRevisionId).toBe(oldRevision.id);
    expect(persistedProject).toMatchObject({
      accessMode: "password",
      passwordHash: "test-existing-hash",
      passwordVersion: 1,
    });
    expect(
      (await prisma.passwordAccessGrant.findUniqueOrThrow({ where: { id: oldGrant.id } }))
        .revokedAt,
    ).toBeNull();
    expect(persistedReplacement.status).toBe(RevisionStatus.PENDING);
    expect(persistedTask.status).toBe(UploadTaskStatus.PROCESSING);
    expect(reservation.status).toBe(QuotaReservationStatus.RESERVED);
  });

  it("rejects a 101st project while still allowing an owner to replace an existing project", async () => {
    if (prisma === null) throw new Error("PHASE9_DATABASE_URL is required");
    const { owner, tenant } = await createOwnerFixture(prisma);
    tenantIds.push(tenant.id);
    const now = new Date("2026-09-03T10:00:00.000Z");
    const projectKeys = Array.from(
      { length: 100 },
      (_, index) => `z${index.toString(36).padStart(4, "0")}`,
    );
    const existingProjectKey = projectKeys[0];
    if (existingProjectKey === undefined) throw new Error("quota fixture must create a project");
    await prisma.demoProject.createMany({
      data: projectKeys.map((projectKey) => ({
        displayName: "Quota project",
        ownerUserId: owner.id,
        projectKey,
        status: DemoProjectStatus.ACTIVE,
        tenantId: tenant.id,
      })),
    });

    const repository = createUploadRepository(prisma);
    await expect(repository.prepare(createPrepareInput(owner, now))).rejects.toMatchObject({
      code: "PROJECT_QUOTA_EXCEEDED",
    });
    await expect(
      repository.prepare(
        createPrepareInput(owner, now, { action: "replace", projectId: existingProjectKey }),
      ),
    ).resolves.toMatchObject({ projectId: existingProjectKey, status: "prepared" });
  });

  it("rejects new storage above 2 GiB and permits it after the project is deleted", async () => {
    if (prisma === null) throw new Error("PHASE9_DATABASE_URL is required");
    const { owner, tenant } = await createOwnerFixture(prisma);
    tenantIds.push(tenant.id);
    const now = new Date("2026-09-03T10:00:00.000Z");
    const project = await prisma.demoProject.create({
      data: {
        displayName: "Storage quota project",
        ownerUserId: owner.id,
        projectKey: `y${randomUUID().replaceAll("-", "").slice(0, 4)}`,
        status: DemoProjectStatus.ACTIVE,
        tenantId: tenant.id,
        totalSize: 2n * 1024n * 1024n * 1024n,
      },
    });

    const repository = createUploadRepository(prisma);
    await expect(repository.prepare(createPrepareInput(owner, now))).rejects.toMatchObject({
      code: "STORAGE_QUOTA_EXCEEDED",
    });
    await prisma.demoProject.update({
      data: { status: DemoProjectStatus.DELETED },
      where: { id: project.id },
    });
    await expect(repository.prepare(createPrepareInput(owner, now))).resolves.toMatchObject({
      status: "prepared",
    });
  });
});

async function createOwnerFixture(prisma: PrismaClient) {
  const suffix = randomUUID();
  const tenant = await prisma.tenant.create({
    data: { dingtalkAppKeyRef: `phase9-quota-${suffix}`, name: "Phase 9 quota" },
  });
  const owner = await prisma.user.create({
    data: {
      dingtalkUserId: `phase9-owner-${suffix}`,
      displayName: "Phase 9 owner",
      lastLoginAt: new Date("2026-09-03T10:00:00.000Z"),
      tenantId: tenant.id,
    },
  });
  return { owner, tenant };
}

function createPrepareInput(
  owner: { dingtalkUserId: string; displayName: string; id: string },
  now: Date,
  overrides: { action?: "create" | "replace"; projectId?: string } = {},
) {
  return {
    action: overrides.action ?? "create",
    clientRequestId: randomUUID(),
    displayName: "Quota upload",
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
    manifestDigest: "a".repeat(64),
    now,
    owner,
    targetHtml: "index.html",
    totalSize: 1,
    ...(overrides.projectId === undefined ? {} : { projectId: overrides.projectId }),
  };
}
