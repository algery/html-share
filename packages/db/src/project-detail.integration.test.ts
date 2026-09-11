import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "./auth-repository.js";
import { createProjectReader } from "./project-reader.js";

const databaseUrl = process.env["PHASE9_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

describeDatabase("project detail database isolation", () => {
  const prisma = databaseUrl === undefined ? null : createPrismaClient(databaseUrl);
  const tenantIds: string[] = [];
  afterAll(async () => {
    if (prisma === null) return;
    for (const tenantId of tenantIds) {
      await prisma.demoProject.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }
    await prisma.$disconnect();
  });

  it("filters ownership and lifecycle in SQL, lists every current file, and switches atomically", async () => {
    if (prisma === null) throw new Error("PHASE9_DATABASE_URL is required");
    const suffix = randomUUID();
    const tenant = await prisma.tenant.create({
      data: { name: "Detail test", dingtalkAppKeyRef: `detail-${suffix}` },
    });
    tenantIds.push(tenant.id);
    const owner = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        displayName: "Owner",
        dingtalkUserId: suffix,
        lastLoginAt: new Date(),
      },
    });
    const stranger = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        displayName: "Stranger",
        dingtalkUserId: `other-${suffix}`,
        lastLoginAt: new Date(),
      },
    });
    const project = await prisma.demoProject.create({
      data: {
        tenantId: tenant.id,
        ownerUserId: owner.id,
        displayName: "Demo",
        projectKey: suffix.replaceAll("-", "").slice(0, 5),
        status: "PENDING",
      },
    });
    const reader = createProjectReader(prisma);
    const input = { ownerUserId: owner.id, projectKey: project.projectKey };
    await expect(reader.findOwnedActiveProject(input)).resolves.toBeNull();
    const revision = await prisma.revision.create({
      data: { projectId: project.id, tenantId: tenant.id, revisionNumber: 1, status: "ACTIVE" },
    });
    await prisma.fileObject.createMany({
      data: ["index.html", "assets/a.js", "nested/中文 页面.html"].map((relativePath) => ({
        tenantId: tenant.id,
        projectId: project.id,
        revisionId: revision.id,
        relativePath,
        size: 1n,
        contentHash: "a".repeat(64),
        mimeType: "text/plain",
        storageKey: `${revision.id}/${relativePath}`,
      })),
    });
    await prisma.demoProject.update({
      where: { id: project.id },
      data: { currentRevisionId: revision.id, status: "ACTIVE", fileCount: 3, totalSize: 3n },
    });
    expect(
      (await reader.findOwnedActiveProject(input))?.files.map((file) => file.relativePath),
    ).toEqual(["assets/a.js", "index.html", "nested/中文 页面.html"]);
    await expect(
      reader.findOwnedActiveProject({ ...input, ownerUserId: stranger.id }),
    ).resolves.toBeNull();
    await expect(
      reader.findOwnedActiveProject({ ...input, projectKey: "zzzzz" }),
    ).resolves.toBeNull();
    const replacement = await prisma.revision.create({
      data: { projectId: project.id, tenantId: tenant.id, revisionNumber: 2, status: "PENDING" },
    });
    await prisma.fileObject.create({
      data: {
        tenantId: tenant.id,
        projectId: project.id,
        revisionId: replacement.id,
        relativePath: "new.html",
        size: 2n,
        contentHash: "b".repeat(64),
        mimeType: "text/html",
        storageKey: `${replacement.id}/new.html`,
      },
    });
    expect((await reader.findOwnedActiveProject(input))?.files).toHaveLength(3);
    await prisma.$transaction([
      prisma.revision.update({ where: { id: revision.id }, data: { status: "OBSOLETE" } }),
      prisma.revision.update({ where: { id: replacement.id }, data: { status: "ACTIVE" } }),
      prisma.demoProject.update({
        where: { id: project.id },
        data: { currentRevisionId: replacement.id, fileCount: 1, totalSize: 2n },
      }),
    ]);
    expect((await reader.findOwnedActiveProject(input))?.files).toEqual([
      { relativePath: "new.html", size: 2 },
    ]);
    await prisma.revision.update({ where: { id: replacement.id }, data: { status: "PENDING" } });
    await expect(reader.findOwnedActiveProject(input)).resolves.toBeNull();
    await prisma.revision.update({ where: { id: replacement.id }, data: { status: "ACTIVE" } });
    await prisma.demoProject.update({ where: { id: project.id }, data: { status: "DELETED" } });
    await expect(reader.findOwnedActiveProject(input)).resolves.toBeNull();
  });
});
