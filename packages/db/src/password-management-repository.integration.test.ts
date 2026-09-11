import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPasswordCrypto,
  createPasswordManagementService,
  createUploadService,
  digestManifest,
} from "@html-share/core";

import { createPasswordAccessFixture, passwordDatabaseUrl } from "./password-access.test-helper.js";
import { createPasswordManagementRepository } from "./password-management-repository.js";
import { createUploadRepository } from "./upload-repository.js";

const suite = passwordDatabaseUrl === undefined ? describe.skip : describe;

suite("project password management transactions", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

  it("regenerates a legacy password, persists recoverable state, then disables it", async () => {
    const fixture = await createPasswordAccessFixture();
    cleanups.push(async () => {
      await fixture.prisma.auditLog.deleteMany({ where: { actorUserId: fixture.owner.id } });
      await fixture.cleanup();
    });
    const project = await fixture.project("mgt01");
    const originalRevisionId = project.revisionId;
    const grant = await fixture.prisma.passwordAccessGrant.create({
      data: {
        expiresAt: new Date(Date.now() + 28_800_000),
        grantHash: randomUUID(),
        passwordVersion: 1,
        projectId: project.id,
        tenantId: fixture.tenant.id,
      },
    });
    const managementCrypto = createPasswordCrypto(Buffer.alloc(32, 10).toString("base64"));
    const service = createPasswordManagementService({
      passwordCrypto: managementCrypto,
      repository: createPasswordManagementRepository(fixture.prisma),
    });

    await expect(
      service.readOwnedProjectAccess({ ownerUserId: fixture.owner.id, projectKey: "mgt01" }),
    ).resolves.toEqual({ accessMode: "password", passwordStatus: "unavailable" });
    const regenerated = await service.changeOwnedProjectAccess({
      action: "regenerate",
      ownerUserId: fixture.owner.id,
      projectKey: "mgt01",
      requestIp: "127.0.0.1",
      traceId: "management-regenerate",
    });
    expect(regenerated.outcome).toBe("updated");
    if (!("access" in regenerated) || regenerated.access.accessPassword === undefined) {
      throw new Error("Expected regenerated password");
    }
    const current = await fixture.prisma.demoProject.findUniqueOrThrow({
      where: { id: project.id },
    });
    expect(current).toMatchObject({
      accessMode: "password",
      currentRevisionId: originalRevisionId,
      passwordVersion: 2,
    });
    expect(current.encryptedPassword).not.toBeNull();
    expect(
      await fixture.crypto.verify(fixture.generated.password, current.passwordHash ?? ""),
    ).toBe(false);
    expect(
      await fixture.crypto.verify(regenerated.access.accessPassword, current.passwordHash ?? ""),
    ).toBe(true);
    expect(
      (await fixture.prisma.passwordAccessGrant.findUniqueOrThrow({ where: { id: grant.id } }))
        .revokedAt,
    ).not.toBeNull();
    await expect(
      service.readOwnedProjectAccess({ ownerUserId: fixture.owner.id, projectKey: "mgt01" }),
    ).resolves.toEqual(regenerated.access);

    await expect(
      service.changeOwnedProjectAccess({
        action: "disable",
        ownerUserId: fixture.owner.id,
        projectKey: "mgt01",
        requestIp: "127.0.0.1",
        traceId: "management-disable",
      }),
    ).resolves.toEqual({
      access: { accessMode: "organization", passwordStatus: "disabled" },
      outcome: "updated",
    });
    expect(
      await fixture.prisma.demoProject.findUniqueOrThrow({ where: { id: project.id } }),
    ).toMatchObject({
      accessMode: "organization",
      currentRevisionId: originalRevisionId,
      encryptedPassword: null,
      passwordHash: null,
      passwordVersion: 3,
    });
    expect(
      await fixture.prisma.auditLog.findMany({
        orderBy: { createdAt: "asc" },
        select: { action: true, requestIp: true, traceId: true },
        where: { projectId: project.id },
      }),
    ).toEqual([
      {
        action: "PASSWORD_ACCESS_REGENERATE",
        requestIp: "127.0.0.1",
        traceId: "management-regenerate",
      },
      {
        action: "PASSWORD_ACCESS_DISABLE",
        requestIp: "127.0.0.1",
        traceId: "management-disable",
      },
    ]);
  });

  it("rejects lifecycle changes while an upload is active without partial state", async () => {
    const fixture = await createPasswordAccessFixture();
    cleanups.push(async () => {
      await fixture.prisma.auditLog.deleteMany({ where: { actorUserId: fixture.owner.id } });
      await fixture.cleanup();
    });
    const project = await fixture.project("mgt02");
    const body = Buffer.from("<h1>replacement</h1>");
    const files = [
      {
        contentMd5: createHash("md5").update(body).digest("base64"),
        mimeType: "text/html; charset=utf-8",
        relativePath: "index.html",
        sha256: createHash("sha256").update(body).digest("hex"),
        size: body.length,
      },
    ];
    const uploads = createUploadService({ repository: createUploadRepository(fixture.prisma) });
    await uploads.prepare({
      action: "replace",
      clientRequestId: randomUUID(),
      displayName: "Blocked replacement",
      files,
      manifestDigest: digestManifest(files),
      owner: fixture.owner,
      projectId: project.projectKey,
      targetHtml: "index.html",
    });
    const service = createPasswordManagementService({
      passwordCrypto: createPasswordCrypto(Buffer.alloc(32, 11).toString("base64")),
      repository: createPasswordManagementRepository(fixture.prisma),
    });
    await expect(
      service.changeOwnedProjectAccess({
        action: "regenerate",
        ownerUserId: fixture.owner.id,
        projectKey: project.projectKey,
        requestIp: "127.0.0.1",
        traceId: "management-conflict",
      }),
    ).resolves.toEqual({ outcome: "upload_conflict" });
    expect(
      await fixture.prisma.demoProject.findUniqueOrThrow({ where: { id: project.id } }),
    ).toMatchObject({
      encryptedPassword: null,
      passwordHash: project.passwordHash,
      passwordVersion: 1,
    });
    expect(await fixture.prisma.auditLog.count({ where: { projectId: project.id } })).toBe(0);
  });

  it("enables organization access without changing revision or files", async () => {
    const fixture = await createPasswordAccessFixture();
    cleanups.push(async () => {
      await fixture.prisma.auditLog.deleteMany({ where: { actorUserId: fixture.owner.id } });
      await fixture.cleanup();
    });
    const passwordProject = await fixture.project("mgt03");
    await fixture.prisma.demoProject.update({
      data: { accessMode: "organization", passwordHash: null },
      where: { id: passwordProject.id },
    });
    const beforeFiles = await fixture.prisma.fileObject.findMany({
      where: { projectId: passwordProject.id },
    });
    const service = createPasswordManagementService({
      passwordCrypto: createPasswordCrypto(Buffer.alloc(32, 12).toString("base64")),
      repository: createPasswordManagementRepository(fixture.prisma),
    });
    const result = await service.changeOwnedProjectAccess({
      action: "enable",
      ownerUserId: fixture.owner.id,
      projectKey: passwordProject.projectKey,
      requestIp: "127.0.0.1",
      traceId: "management-enable",
    });
    expect(result.outcome).toBe("updated");
    const current = await fixture.prisma.demoProject.findUniqueOrThrow({
      where: { id: passwordProject.id },
    });
    expect(current).toMatchObject({
      accessMode: "password",
      currentRevisionId: passwordProject.revisionId,
      fileCount: passwordProject.fileCount,
      passwordVersion: 2,
      totalSize: passwordProject.totalSize,
    });
    expect(current.encryptedPassword).not.toBeNull();
    expect(await fixture.prisma.fileObject.findMany({ where: { projectId: current.id } })).toEqual(
      beforeFiles,
    );
  });

  it("rolls back late audit failures and serializes competing mutations", async () => {
    const fixture = await createPasswordAccessFixture();
    cleanups.push(async () => {
      await fixture.prisma.auditLog.deleteMany({ where: { actorUserId: fixture.owner.id } });
      await fixture.cleanup();
    });
    const project = await fixture.project("mgt04");
    const repository = createPasswordManagementRepository(fixture.prisma);
    const before = await fixture.prisma.demoProject.findUniqueOrThrow({
      where: { id: project.id },
    });
    const grant = await fixture.prisma.passwordAccessGrant.create({
      data: {
        expiresAt: new Date(Date.now() + 28_800_000),
        grantHash: randomUUID(),
        passwordVersion: 1,
        projectId: project.id,
        tenantId: fixture.tenant.id,
      },
    });
    const mutation = {
      action: "regenerate" as const,
      encryptedPassword: "synthetic-ciphertext",
      expectedAccessMode: "password" as const,
      expectedPasswordVersion: 1,
      now: new Date("2026-09-10T00:00:00Z"),
      ownerUserId: fixture.owner.id,
      passwordHash: "synthetic-hash",
      passwordVersion: 2,
      projectKey: project.projectKey,
      requestIp: "127.0.0.1",
    };
    await expect(
      repository.applyOwnedChange({ ...mutation, traceId: "x".repeat(65) }),
    ).rejects.toBeDefined();
    expect(
      await fixture.prisma.demoProject.findUniqueOrThrow({ where: { id: project.id } }),
    ).toEqual(before);
    expect(await fixture.prisma.auditLog.count({ where: { projectId: project.id } })).toBe(0);
    expect(
      (await fixture.prisma.passwordAccessGrant.findUniqueOrThrow({ where: { id: grant.id } }))
        .revokedAt,
    ).toBeNull();

    const outcomes = await Promise.all([
      repository.applyOwnedChange({ ...mutation, traceId: "management-race-a" }),
      repository.applyOwnedChange({ ...mutation, traceId: "management-race-b" }),
    ]);
    expect(outcomes.sort()).toEqual(["conflict", "updated"]);
    expect(await fixture.prisma.auditLog.count({ where: { projectId: project.id } })).toBe(1);
    expect(
      (await fixture.prisma.demoProject.findUniqueOrThrow({ where: { id: project.id } }))
        .passwordVersion,
    ).toBe(2);
  });
});
