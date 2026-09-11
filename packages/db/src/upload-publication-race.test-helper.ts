import { randomUUID } from "node:crypto";

import {
  DemoProjectStatus,
  RevisionStatus,
  UploadAction,
  UploadFileVerificationStatus,
  UploadTaskStatus,
} from "./generated/prisma/client.js";
import { createPrismaClient } from "./auth-repository.js";

type TestPrisma = NonNullable<ReturnType<typeof createPrismaClient>>;

export async function waitForBlockedProjectLock(prisma: TestPrisma) {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    const rows = await prisma.$queryRaw<{ blocked: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND datname = current_database()
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND query LIKE '%demo_projects%'
          AND query LIKE '%FOR UPDATE%'
      ) AS "blocked"
    `;
    if (rows[0]?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("publication or preparation did not block on the project lock");
}

export async function waitForDatabaseTime(prisma: TestPrisma, deadline: Date) {
  const timeoutAt = performance.now() + 2_000;
  while (performance.now() < timeoutAt) {
    const rows = await prisma.$queryRaw<{ passed: boolean }[]>`
      SELECT clock_timestamp() > ${deadline} AS "passed"
    `;
    if (rows[0]?.passed === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("database clock did not pass upload expiry");
}

export async function createPublicationRaceFixture(prisma: TestPrisma, now: Date, expiresAt: Date) {
  const suffix = randomUUID().replaceAll("-", "");
  const tenant = await prisma.tenant.create({
    data: { dingtalkAppKeyRef: `publication-race-${suffix}`, name: "Publication race" },
  });
  const owner = await prisma.user.create({
    data: {
      dingtalkUserId: `publication-race-${suffix}`,
      displayName: "Publication race owner",
      lastLoginAt: now,
      tenantId: tenant.id,
    },
  });
  const project = await prisma.demoProject.create({
    data: {
      displayName: "Existing demo",
      ownerUserId: owner.id,
      projectKey: `r${suffix.slice(0, 4)}`,
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
  const revision = await prisma.revision.create({
    data: { projectId: project.id, revisionNumber: 2, tenantId: tenant.id },
  });
  const newStorageKey = `projects/${project.projectKey}/revisions/2/index.html`;
  const upload = await prisma.uploadTask.create({
    data: {
      action: UploadAction.REPLACE,
      clientRequestId: randomUUID(),
      declaredFileCount: 1,
      declaredTotalSize: 3n,
      displayName: "Expired replacement",
      expiresAt,
      manifestDigest: "a".repeat(64),
      ownerUserId: owner.id,
      projectId: project.id,
      revisionId: revision.id,
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
          revisionId: revision.id,
          storageKey: newStorageKey,
          tenantId: tenant.id,
          verificationStatus: UploadFileVerificationStatus.VERIFIED,
          verifiedAt: now,
        },
      },
    },
  });
  await prisma.quotaReservation.create({
    data: {
      expiresAt,
      projectDelta: 0,
      storageBytes: 0n,
      tenantId: tenant.id,
      uploadTaskId: upload.id,
      userId: owner.id,
    },
  });
  return {
    newStorageKey,
    oldRevisionId: oldRevision.id,
    ownerId: owner.id,
    projectKey: project.projectKey,
    projectId: project.id,
    revisionId: revision.id,
    tenantId: tenant.id,
    uploadId: upload.id,
  };
}
