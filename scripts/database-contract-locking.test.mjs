import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

import { databaseContract } from "./database-contract-fixture.mjs";
import { interleaveProject, waitForDatabaseDeadline } from "./database-contract-locks.mjs";

databaseContract("real project row-lock interleavings", (current) => {
  it("refuses publication that expires while blocked and preserves the old active revision", async () => {
    const f = current();
    const original = await f.project();
    const replacement = await f.service.prepare(
      f.request({ action: "replace", projectId: original.prepared.projectId }),
    );
    const task = await f.ready(replacement);
    const deadline = new Date(Date.now() + 400);
    await f.db.uploadTask.update({ where: { id: task.id }, data: { expiresAt: deadline } });
    const result = await interleaveProject(
      f,
      original.stored.id,
      () => f.second.uploads.publishUpload({ uploadId: task.id, now: f.now }),
      async () => {},
      () => waitForDatabaseDeadline(f, deadline),
    );
    expect(result).toBe(false);
    expect(
      await f.db.demoProject.findUniqueOrThrow({ where: { id: original.stored.id } }),
    ).toMatchObject({ currentRevisionId: original.stored.currentRevisionId, status: "ACTIVE" });
    expect(await f.db.fileObject.count({ where: { revisionId: task.revisionId } })).toBe(0);
    expect(
      await f.db.quotaReservation.findUniqueOrThrow({ where: { uploadTaskId: task.id } }),
    ).toMatchObject({ status: "RESERVED" });
  });

  it("rechecks homepage membership after waiting for the current file set to change", async () => {
    const f = current();
    const original = await f.project();
    const result = await interleaveProject(
      f,
      original.stored.id,
      () =>
        f.second.projects.setOwnedHomepage({
          ownerUserId: f.owner.id,
          projectKey: original.prepared.projectId,
          relativePath: "index.html",
        }),
      (tx) =>
        tx.fileObject.deleteMany({ where: { revisionId: original.stored.currentRevisionId } }),
    );
    expect(result).toBe("invalid_file");
    expect(
      await f.db.demoProject.findUniqueOrThrow({ where: { id: original.stored.id } }),
    ).toMatchObject({ homepagePath: null });
  });

  it("rechecks the password version after a conflicting committed change", async () => {
    const f = current();
    const original = await f.project({ accessMode: "password" });
    const result = await interleaveProject(
      f,
      original.stored.id,
      () =>
        f.second.passwordManagement.applyOwnedChange({
          action: "disable",
          encryptedPassword: null,
          passwordHash: null,
          expectedAccessMode: "password",
          expectedPasswordVersion: original.stored.passwordVersion,
          passwordVersion: original.stored.passwordVersion + 1,
          ownerUserId: f.owner.id,
          projectKey: original.prepared.projectId,
          requestIp: "127.0.0.1",
          traceId: randomUUID(),
          now: f.now,
        }),
      (tx) =>
        tx.demoProject.update({
          where: { id: original.stored.id },
          data: { passwordVersion: { increment: 1 } },
        }),
    );
    expect(result).toBe("conflict");
    expect(
      await f.db.demoProject.findUniqueOrThrow({ where: { id: original.stored.id } }),
    ).toMatchObject({ accessMode: "password", passwordHash: original.stored.passwordHash });
    expect(await f.db.auditLog.count({ where: { actorUserId: f.owner.id } })).toBe(0);
  });

  it("rejects a grant using a password snapshot invalidated while it waits", async () => {
    const f = current();
    const original = await f.project({ accessMode: "password" });
    const path = { projectKey: original.prepared.projectId, relativePath: "index.html" };
    const target = await f.repositories.passwordAccess.findTarget(path);
    const result = await interleaveProject(
      f,
      original.stored.id,
      () =>
        f.second.passwordAccess.createGrant({
          target,
          relativePath: "index.html",
          grantHash: randomUUID(),
          now: f.now,
          expiresAt: new Date(f.now.getTime() + 60_000),
        }),
      (tx) =>
        tx.demoProject.update({
          where: { id: original.stored.id },
          data: { passwordVersion: { increment: 1 } },
        }),
    );
    expect(result).toBe(false);
    expect(await f.db.passwordAccessGrant.count({ where: { projectId: original.stored.id } })).toBe(
      0,
    );
  });

  it("takes deletion's complete object snapshot after waiting and writes one administrator audit", async () => {
    const f = current();
    const original = await f.project();
    const lateKey = `projects/${original.stored.id}/late/中文😀/A.html`;
    const result = await interleaveProject(
      f,
      original.stored.id,
      () =>
        f.second.deletion.deleteAsAdministrator({
          actorUserId: f.owner.id,
          projectKey: original.prepared.projectId,
          reason: "contract",
          requestIp: "127.0.0.1",
          traceId: randomUUID(),
          now: f.now,
        }),
      (tx) =>
        tx.fileObject.create({
          data: {
            tenantId: f.tenant.id,
            projectId: original.stored.id,
            revisionId: original.stored.currentRevisionId,
            relativePath: "late.html",
            size: 1n,
            contentHash: "c".repeat(64),
            mimeType: "text/html",
            storageKey: lateKey,
          },
        }),
    );
    expect(result).toBe("deleted");
    const cleanup = await f.db.cleanupJob.findFirstOrThrow({
      where: { kind: "PROJECT", targetId: original.stored.id },
    });
    expect(cleanup.objectKeys).toContain(lateKey);
    expect(
      await f.db.demoProject.findUniqueOrThrow({ where: { id: original.stored.id } }),
    ).toMatchObject({ status: "DELETED", currentRevisionId: null, totalSize: 0n, fileCount: 0 });
    expect(
      await f.db.auditLog.count({ where: { actorUserId: f.owner.id, action: "PROJECT_DELETE" } }),
    ).toBe(1);
    expect(
      await f.second.deletion.deleteAsAdministrator({
        actorUserId: f.owner.id,
        projectKey: original.prepared.projectId,
        reason: "retry",
        requestIp: "127.0.0.1",
        traceId: randomUUID(),
        now: f.now,
      }),
    ).toBe("already_deleted");
    expect(
      await f.db.auditLog.count({ where: { actorUserId: f.owner.id, action: "PROJECT_DELETE" } }),
    ).toBe(1);
  });
});
