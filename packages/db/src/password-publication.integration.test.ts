import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPasswordCrypto,
  createUploadService,
  digestManifest,
  projectPasswordContext,
} from "@html-share/core";
import { createPrismaClient } from "./auth-repository.js";
import { createUploadRepository } from "./upload-repository.js";
import { createPasswordCleanupRepository } from "./password-cleanup-repository.js";
import { createProjectDeletionRepository } from "./project-deletion-repository.js";

const url = process.env["PHASE9_DATABASE_URL"];
const suite = url === undefined ? describe.skip : describe;

suite("password publication transactions", () => {
  const prisma = createPrismaClient(url ?? "postgresql://unused:unused@localhost:1/unused");
  const crypto = createPasswordCrypto(Buffer.alloc(32, 3).toString("base64"));
  const managementCrypto = createPasswordCrypto(Buffer.alloc(32, 4).toString("base64"));
  const repository = createUploadRepository(prisma, {
    passwordCrypto: crypto,
    passwordManagementCrypto: managementCrypto,
  });
  const service = createUploadService({ repository });
  let tenantId: string;
  let owner: { id: string; dingtalkUserId: string | null; displayName: string };
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({
      data: { name: "Password publication test", dingtalkAppKeyRef: randomUUID() },
    });
    tenantId = tenant.id;
    owner = await prisma.user.create({
      data: {
        tenantId,
        dingtalkUserId: randomUUID(),
        displayName: "Password test",
        lastLoginAt: new Date(),
      },
    });
  });
  afterAll(async () => {
    if (tenantId) {
      const projects = await prisma.demoProject.findMany({
        where: { tenantId },
        select: { id: true },
      });
      await prisma.auditLog.deleteMany({ where: { ownerUserId: owner.id } });
      await prisma.cleanupJob.deleteMany({
        where: {
          kind: "PROJECT",
          targetId: { in: projects.map(({ id }) => id) },
        },
      });
      await prisma.demoProject.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }
    await prisma.$disconnect();
  });

  function input(projectId?: string) {
    const body = Buffer.from("<h1>Password test</h1>");
    const files = [
      {
        relativePath: "folder/测试 file.html",
        size: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
        contentMd5: createHash("md5").update(body).digest("base64"),
        mimeType: "text/html; charset=utf-8",
      },
    ];
    return {
      action: projectId ? ("replace" as const) : ("create" as const),
      ...(projectId ? { projectId } : {}),
      clientRequestId: randomUUID(),
      displayName: "Password demo",
      files,
      manifestDigest: digestManifest(files),
      targetHtml: "folder/测试 file.html",
      owner,
    };
  }
  async function publish(uploadId: string) {
    expect((await service.complete({ ownerUserId: owner.id, uploadId })).status).toBe("processing");
    await repository.markUploadFilesVerified({ uploadId, now: new Date() });
    expect(await repository.publishUpload({ uploadId, now: new Date() })).toBe(true);
    return service.status({ ownerUserId: owner.id, uploadId });
  }
  async function createPasswordProject() {
    const request = { ...input(), accessMode: "password" as const };
    const prepared = await service.prepare(request);
    const result = await publish(prepared.uploadId);
    const project = await prisma.demoProject.findUniqueOrThrow({
      where: { projectKey: prepared.projectId },
    });
    return { request, prepared, result, project };
  }
  async function grant(projectId: string, passwordVersion: number) {
    return prisma.passwordAccessGrant.create({
      data: {
        tenantId,
        projectId,
        passwordVersion,
        grantHash: randomUUID(),
        expiresAt: new Date(Date.now() + 28_800_000),
      },
    });
  }

  it("preserves old requests and activates password data only with successful content", async () => {
    const old = await service.prepare(input());
    expect(await publish(old.uploadId)).toMatchObject({ accessMode: "organization" });
    const prepared = await service.prepare({ ...input(), accessMode: "password" });
    const before = await prisma.demoProject.findUniqueOrThrow({
      where: { projectKey: prepared.projectId },
    });
    expect(before).toMatchObject({
      accessMode: "organization",
      passwordHash: null,
      status: "PENDING",
    });
    expect(
      await service.status({ ownerUserId: owner.id, uploadId: prepared.uploadId }),
    ).not.toHaveProperty("accessPassword");
    const result = await publish(prepared.uploadId);
    expect(result).toMatchObject({
      accessMode: "password",
      passwordStatus: "generated",
      targetHtml: "folder/测试 file.html",
    });
    const project = await prisma.demoProject.findUniqueOrThrow({ where: { id: before.id } });
    expect(
      await crypto.verify(required(result.accessPassword), required(project.passwordHash)),
    ).toBe(true);
    expect(
      managementCrypto.decrypt(
        required(project.encryptedPassword),
        projectPasswordContext(project),
      ),
    ).toBe(result.accessPassword);
    const task = await prisma.uploadTask.findUniqueOrThrow({ where: { id: prepared.uploadId } });
    expect(task.pendingEncryptedPassword).toBeNull();
    expect(
      JSON.stringify(task, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toContain(required(result.accessPassword));
  });

  it("retries the same task without changing password and rejects altered options", async () => {
    const { request, prepared, result } = await createPasswordProject();
    expect(await service.prepare(request)).toMatchObject({
      uploadId: prepared.uploadId,
      idempotent: true,
    });
    expect(
      await service.complete({ ownerUserId: owner.id, uploadId: prepared.uploadId }),
    ).toMatchObject({ accessPassword: result.accessPassword });
    await expect(service.prepare({ ...request, accessMode: "organization" })).rejects.toMatchObject(
      { code: "INVALID_UPLOAD_INPUT" },
    );
    await expect(service.prepare({ ...request, targetHtml: "other.html" })).rejects.toMatchObject({
      code: "INVALID_UPLOAD_INPUT",
    });
    await expect(
      service.status({ ownerUserId: randomUUID(), uploadId: prepared.uploadId }),
    ).rejects.toMatchObject({ code: "UPLOAD_NOT_FOUND" });
  });

  it("inherits the original password and explicit repeated enabling does not reset it", async () => {
    const { prepared, project } = await createPasswordProject();
    for (const options of [{}, { accessMode: "password" as const }]) {
      const replacement = await service.prepare({ ...input(prepared.projectId), ...options });
      expect(await publish(replacement.uploadId)).toMatchObject({
        accessMode: "password",
        passwordStatus: "retained",
      });
      const current = await prisma.demoProject.findUniqueOrThrow({ where: { id: project.id } });
      expect(current.passwordHash).toBe(project.passwordHash);
      expect(current.passwordVersion).toBe(project.passwordVersion);
    }
  });

  it("resets atomically, revokes grants and prevents retrieval through old tasks", async () => {
    const { prepared, project } = await createPasswordProject();
    const oldGrant = await grant(project.id, project.passwordVersion);
    const replacement = await service.prepare({
      ...input(prepared.projectId),
      regeneratePassword: true,
    });
    expect(
      (await prisma.demoProject.findUniqueOrThrow({ where: { id: project.id } })).passwordVersion,
    ).toBe(project.passwordVersion);
    const result = await publish(replacement.uploadId);
    const current = await prisma.demoProject.findUniqueOrThrow({ where: { id: project.id } });
    expect(current.passwordVersion).toBe(project.passwordVersion + 1);
    expect(
      await crypto.verify(required(result.accessPassword), required(current.passwordHash)),
    ).toBe(true);
    expect(
      (await prisma.passwordAccessGrant.findUniqueOrThrow({ where: { id: oldGrant.id } }))
        .revokedAt,
    ).not.toBeNull();
    expect(
      await service.status({ ownerUserId: owner.id, uploadId: prepared.uploadId }),
    ).toMatchObject({ passwordStatus: "unavailable" });
  });

  it("disables password access and retains organization content", async () => {
    const { prepared, project } = await createPasswordProject();
    const oldGrant = await grant(project.id, project.passwordVersion);
    const replacement = await service.prepare({
      ...input(prepared.projectId),
      accessMode: "organization",
    });
    const result = await publish(replacement.uploadId);
    expect(result.accessPassword).toBeUndefined();
    expect(await prisma.demoProject.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject(
      {
        status: "ACTIVE",
        accessMode: "organization",
        encryptedPassword: null,
        passwordHash: null,
        passwordVersion: project.passwordVersion + 1,
      },
    );
    expect(
      (await prisma.passwordAccessGrant.findUniqueOrThrow({ where: { id: oldGrant.id } }))
        .revokedAt,
    ).not.toBeNull();
    await expect(
      service.prepare({ ...input(prepared.projectId), regeneratePassword: true }),
    ).rejects.toMatchObject({ code: "INVALID_UPLOAD_INPUT" });
  });

  it("keeps old mode, content, password and grant after failed replacement", async () => {
    const { prepared, project } = await createPasswordProject();
    const oldGrant = await grant(project.id, project.passwordVersion);
    const replacement = await service.prepare({
      ...input(prepared.projectId),
      regeneratePassword: true,
    });
    await repository.failUpload({
      uploadId: replacement.uploadId,
      failureCode: "metadata_mismatch",
      now: new Date(),
    });
    const current = await prisma.demoProject.findUniqueOrThrow({ where: { id: project.id } });
    expect(current).toMatchObject({
      accessMode: project.accessMode,
      passwordHash: project.passwordHash,
      passwordVersion: project.passwordVersion,
      currentRevisionId: project.currentRevisionId,
    });
    expect(
      (await prisma.passwordAccessGrant.findUniqueOrThrow({ where: { id: oldGrant.id } }))
        .revokedAt,
    ).toBeNull();
    expect(
      await service.status({ ownerUserId: owner.id, uploadId: replacement.uploadId }),
    ).not.toHaveProperty("accessPassword");
  });

  it("rejects expired results before cleanup, then cleans only transient password data", async () => {
    const { prepared, project } = await createPasswordProject();
    const future = new Date(Date.now() + 86_400_001);
    expect(
      await repository.getStatus({
        ownerUserId: owner.id,
        uploadId: prepared.uploadId,
        now: future,
      }),
    ).toMatchObject({ passwordStatus: "unavailable" });
    await grant(project.id, project.passwordVersion);
    await createPasswordCleanupRepository(prisma).cleanupExpired(future);
    const task = await prisma.uploadTask.findUniqueOrThrow({ where: { id: prepared.uploadId } });
    expect(task.encryptedPasswordResult).toBeNull();
    expect(task.pendingPasswordHash).toBeNull();
    expect(
      (await prisma.demoProject.findUniqueOrThrow({ where: { id: project.id } })).passwordHash,
    ).toBe(project.passwordHash);
  });

  it("rejects tampered encrypted results without exposing password and deletes all credentials", async () => {
    const { prepared, project } = await createPasswordProject();
    await prisma.uploadTask.update({
      where: { id: prepared.uploadId },
      data: { encryptedPasswordResult: "invalid" },
    });
    await expect(
      service.status({ ownerUserId: owner.id, uploadId: prepared.uploadId }),
    ).rejects.toThrow("Password result decryption failed");
    await grant(project.id, project.passwordVersion);
    expect(
      await createProjectDeletionRepository(prisma).deleteAsOwner({
        ownerUserId: owner.id,
        projectKey: prepared.projectId,
        now: new Date(),
      }),
    ).toBe("deleted");
    expect(await prisma.passwordAccessGrant.count({ where: { projectId: project.id } })).toBe(0);
    const deletedResult = await service.status({
      ownerUserId: owner.id,
      uploadId: prepared.uploadId,
    });
    expect(deletedResult).not.toHaveProperty("accessPassword");
    expect(deletedResult).toMatchObject({ accessMode: "password", passwordStatus: "unavailable" });
    expect(await prisma.demoProject.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject(
      { encryptedPassword: null, passwordHash: null },
    );
  });
});

function required(value: string | null | undefined): string {
  if (value === null || value === undefined) throw new Error("Expected password field missing");
  return value;
}
