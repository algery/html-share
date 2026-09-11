import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPasswordAccessFixture, passwordDatabaseUrl } from "./password-access.test-helper.js";

const suite = passwordDatabaseUrl ? describe : describe.skip;
suite("password project credentials and exact file authorization", () => {
  let fixture: Awaited<ReturnType<typeof createPasswordAccessFixture>>;
  beforeAll(async () => {
    fixture = await createPasswordAccessFixture();
  });
  afterAll(async () => {
    if (fixture) await fixture.cleanup();
  });

  it("issues without an organization user session and shares only exact files of the same project", async () => {
    const { project, service, prisma, generated, tenant } = fixture;
    const first = await project();
    const second = await project();
    const userCount = await prisma.user.count({ where: { tenantId: tenant.id } });
    const issued = await service.verifyPassword({
      ...first.path,
      password: ` ${generated.password}\n`,
    });
    expect(issued).not.toBeNull();
    const token = required(issued).token;
    const grant = await prisma.passwordAccessGrant.findFirstOrThrow({
      where: { projectId: first.id },
    });
    expect(grant).toMatchObject({
      tenantId: tenant.id,
      passwordVersion: 1,
      grantHash: createHash("sha256").update(token).digest("hex"),
    });
    expect(await prisma.user.count({ where: { tenantId: tenant.id } })).toBe(userCount);
    expect(await service.authorize({ ...first.path, token })).toMatchObject({
      file: { relativePath: first.path.relativePath, size: 10 },
      principal: `password:${grant.id}`,
    });
    expect(await service.authorize({ ...second.path, token })).toBeNull();
    expect(
      await service.authorize({ ...first.path, token, relativePath: "missing.html" }),
    ).toBeNull();
    expect(await service.authorize({ ...first.path, tenantId: randomUUID() })).toBeNull();
    expect(await service.authorize({ ...first.path, tenantId: tenant.id })).not.toBeNull();
    expect(await service.getTarget({ ...first.path, relativePath: "missing.html" })).toBeNull();
    await prisma.fileObject.create({
      data: {
        tenantId: tenant.id,
        projectId: first.id,
        revisionId: first.revisionId,
        relativePath: "assets/style.css",
        size: 4,
        contentHash: "b".repeat(64),
        mimeType: "text/css",
        storageKey: `${first.id}/style.css`,
      },
    });
    expect(
      await service.authorize({ ...first.path, token, relativePath: "assets/style.css" }),
    ).not.toBeNull();
    fixture.setNow(new Date(required(issued).expiresAt.getTime() - 1));
    expect(await service.authorize({ ...first.path, token })).not.toBeNull();
    fixture.setNow(required(issued).expiresAt);
    expect(await service.authorize({ ...first.path, token })).toBeNull();
    fixture.setNow(new Date());
  });

  it.each([
    "version",
    "closed",
    "revoked",
    "deleted",
    "pending",
    "missing-file",
    "obsolete-revision",
  ] as const)("immediately rejects the previous credential after %s", async (change) => {
    const { project, service, prisma, generated, tenant } = fixture;
    const item = await project();
    const issued = await service.verifyPassword({ ...item.path, password: generated.password });
    expect(issued).not.toBeNull();
    if (change === "version")
      await prisma.demoProject.update({ where: { id: item.id }, data: { passwordVersion: 2 } });
    if (change === "closed")
      await prisma.demoProject.update({
        where: { id: item.id },
        data: { accessMode: "organization", passwordHash: null },
      });
    if (change === "revoked")
      await prisma.passwordAccessGrant.updateMany({
        where: { projectId: item.id },
        data: { revokedAt: new Date() },
      });
    if (change === "deleted" || change === "pending")
      await prisma.demoProject.update({
        where: { id: item.id },
        data: { status: change === "deleted" ? "DELETED" : "PENDING" },
      });
    if (change === "missing-file") await prisma.fileObject.delete({ where: { id: item.fileId } });
    if (change === "obsolete-revision")
      await prisma.revision.update({
        where: { id: item.revisionId },
        data: { status: "OBSOLETE" },
      });
    expect(await service.authorize({ ...item.path, token: required(issued).token })).toBeNull();
    if (change === "closed") {
      expect(await service.authorize({ ...item.path, tenantId: tenant.id })).not.toBeNull();
      expect(
        await service.verifyPassword({ ...item.path, password: generated.password }),
      ).toBeNull();
    }
  });

  it("does not inherit credentials when a deleted project's short code is reused", async () => {
    const { project, service, prisma, generated } = fixture;
    const old = await project();
    const issued = await service.verifyPassword({ ...old.path, password: generated.password });
    await prisma.demoProject.update({
      where: { id: old.id },
      data: { status: "DELETED", projectKey: randomUUID().slice(0, 5) },
    });
    const replacement = await project(old.projectKey);
    expect(replacement.id).not.toBe(old.id);
    expect(
      await service.authorize({ ...replacement.path, token: required(issued).token }),
    ).toBeNull();
    expect(
      await service.verifyPassword({ ...replacement.path, password: generated.password }),
    ).not.toBeNull();
  });

  it("keeps a grant across a current revision switch but reads only the new exact file set", async () => {
    const { project, service, prisma, generated, tenant } = fixture;
    const item = await project();
    const issued = required(
      await service.verifyPassword({ ...item.path, password: generated.password }),
    );
    const next = await prisma.revision.create({
      data: { tenantId: tenant.id, projectId: item.id, revisionNumber: 2, status: "ACTIVE" },
    });
    await prisma.fileObject.create({
      data: {
        tenantId: tenant.id,
        projectId: item.id,
        revisionId: next.id,
        relativePath: "next/index.html",
        contentHash: "c".repeat(64),
        mimeType: "text/html",
        size: 5,
        storageKey: `${item.id}/${next.id}/next/index.html`,
      },
    });
    await prisma.demoProject.update({
      where: { id: item.id },
      data: { currentRevisionId: next.id },
    });
    expect(await service.authorize({ ...item.path, token: issued.token })).toBeNull();
    expect(
      await service.authorize({
        ...item.path,
        token: issued.token,
        relativePath: "next/index.html",
      }),
    ).toMatchObject({ file: { contentHash: "c".repeat(64), size: 5 } });
    expect(await service.verifyPassword({ ...item.path, password: generated.password })).toBeNull();
  });

  it("rejects disabled tenants and mismatched grant/revision/file tenant or project relations", async () => {
    const { project, service, prisma, generated, tenant } = fixture;
    const item = await project();
    const another = await project();
    const issued = await service.verifyPassword({ ...item.path, password: generated.password });
    const token = required(issued).token;
    const foreign = await prisma.tenant.create({
      data: { name: "Foreign test", dingtalkAppKeyRef: randomUUID() },
    });
    try {
      await prisma.passwordAccessGrant.updateMany({
        where: { projectId: item.id },
        data: { tenantId: foreign.id },
      });
      expect(await service.authorize({ ...item.path, token })).toBeNull();
      await prisma.passwordAccessGrant.updateMany({
        where: { projectId: item.id },
        data: { tenantId: tenant.id },
      });
      for (const relation of [
        "file-tenant",
        "file-project",
        "revision-tenant",
        "revision-project",
      ] as const) {
        if (relation === "file-tenant")
          await prisma.fileObject.update({
            where: { id: item.fileId },
            data: { tenantId: foreign.id },
          });
        if (relation === "file-project")
          await prisma.fileObject.update({
            where: { id: item.fileId },
            data: { projectId: another.id },
          });
        if (relation === "revision-tenant")
          await prisma.revision.update({
            where: { id: item.revisionId },
            data: { tenantId: foreign.id },
          });
        if (relation === "revision-project")
          await prisma.revision.update({
            where: { id: item.revisionId },
            data: { projectId: another.id, revisionNumber: 99 },
          });
        expect(await service.getTarget(item.path)).toBeNull();
        expect(await service.authorize({ ...item.path, token, tenantId: tenant.id })).toBeNull();
        await prisma.fileObject.update({
          where: { id: item.fileId },
          data: { tenantId: tenant.id, projectId: item.id },
        });
        await prisma.revision.update({
          where: { id: item.revisionId },
          data: { tenantId: tenant.id, projectId: item.id, revisionNumber: 1 },
        });
      }
      await prisma.tenant.update({ where: { id: tenant.id }, data: { status: "DISABLED" } });
      expect(await service.getTarget(item.path)).toBeNull();
      expect(
        await service.verifyPassword({ ...item.path, password: generated.password }),
      ).toBeNull();
      expect(await service.authorize({ ...item.path, token, tenantId: tenant.id })).toBeNull();
    } finally {
      await prisma.tenant.update({ where: { id: tenant.id }, data: { status: "ACTIVE" } });
      await prisma.tenant.delete({ where: { id: foreign.id } });
    }
  });
});

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected a successful credential");
  return value;
}
