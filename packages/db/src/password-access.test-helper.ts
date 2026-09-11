import { randomUUID } from "node:crypto";
import { createPasswordAccessService, createPasswordCrypto } from "@html-share/core";
import { createPrismaClient } from "./auth-repository.js";
import { createPasswordAccessRepository } from "./password-access-repository.js";

export const passwordDatabaseUrl = process.env["PHASE9_DATABASE_URL"];
// Refuse accidental execution against a developer or production database.
if (passwordDatabaseUrl) {
  const parsed = new URL(passwordDatabaseUrl);
  if (
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== "55432" ||
    parsed.pathname !== "/html_share_password"
  )
    throw new Error("Password tests require the isolated password database");
}

export async function createPasswordAccessFixture() {
  const prisma = createPrismaClient(
    passwordDatabaseUrl ?? "postgresql://unused:unused@localhost:1/unused",
  );
  const crypto = createPasswordCrypto(Buffer.alloc(32, 7).toString("base64"));
  const generated = await crypto.generate();
  const tenant = await prisma.tenant.create({
    data: { name: "Password access test", dingtalkAppKeyRef: randomUUID() },
  });
  const owner = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      dingtalkUserId: randomUUID(),
      displayName: "Publisher",
      lastLoginAt: new Date(),
    },
  });
  const repository = createPasswordAccessRepository(prisma);
  let now = new Date();
  const service = createPasswordAccessService({
    repository,
    passwordCrypto: crypto,
    now: () => now,
  });

  async function project(projectKey = randomUUID().replaceAll("-", "").slice(0, 5)) {
    const project = await prisma.demoProject.create({
      data: {
        tenantId: tenant.id,
        ownerUserId: owner.id,
        projectKey,
        displayName: "Test demo",
        accessMode: "password",
        passwordHash: generated.hash,
        passwordVersion: 1,
        status: "ACTIVE",
      },
    });
    const revision = await prisma.revision.create({
      data: { tenantId: tenant.id, projectId: project.id, revisionNumber: 1, status: "ACTIVE" },
    });
    await prisma.demoProject.update({
      where: { id: project.id },
      data: { currentRevisionId: revision.id },
    });
    const path = { projectKey, relativePath: "目录/test file.html" };
    const file = await prisma.fileObject.create({
      data: {
        tenantId: tenant.id,
        projectId: project.id,
        revisionId: revision.id,
        relativePath: path.relativePath,
        contentHash: "a".repeat(64),
        mimeType: "text/html",
        size: 10,
        storageKey: `projects/${project.id}/${revision.id}/${path.relativePath}`,
      },
    });
    return { ...project, revisionId: revision.id, fileId: file.id, path };
  }
  return {
    prisma,
    crypto,
    generated,
    tenant,
    owner,
    service,
    repository,
    project,
    setNow: (value: Date) => {
      now = value;
    },
    cleanup: async () => {
      await prisma.demoProject.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.user.deleteMany({ where: { tenantId: tenant.id } });
      await prisma.tenant.delete({ where: { id: tenant.id } });
      await prisma.$disconnect();
    },
  };
}

export async function waitForPasswordGrantLock(prisma: ReturnType<typeof createPrismaClient>) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ blocked: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
        AND pid <> pg_backend_pid() AND state = 'active' AND wait_event_type = 'Lock'
        AND query LIKE '%demo_projects%' AND query LIKE '%FOR SHARE%') AS "blocked"`;
    if (rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Grant issuance did not wait for the project lock");
}
