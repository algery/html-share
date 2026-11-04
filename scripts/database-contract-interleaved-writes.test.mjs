import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

import { databaseContract, manifest } from "./database-contract-fixture.mjs";
import { interleaveProject, waitForProjectWait } from "./database-contract-locks.mjs";

databaseContract("concurrent real repository writers", (current) => {
  it("serializes a real publisher and password manager without committing stale credentials", async () => {
    const f = current();
    const original = await f.project({ accessMode: "password" });
    const replacement = await f.service.prepare(
      f.request({
        action: "replace",
        projectId: original.prepared.projectId,
        regeneratePassword: true,
      }),
    );
    const task = await f.ready(replacement);
    let changing;
    let published;
    try {
      published = await interleaveProject(
        f,
        original.stored.id,
        () => f.second.uploads.publishUpload({ uploadId: task.id, now: f.now }),
        async () => {},
        async () => {
          changing = f.repositories.passwordManagement.applyOwnedChange({
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
          });
          await waitForProjectWait(f, 2);
        },
      );
    } finally {
      await Promise.allSettled([changing]);
    }
    expect(published).toBe(true);
    expect(["conflict", "upload_conflict"]).toContain(await changing);
    const stored = await f.db.demoProject.findUniqueOrThrow({ where: { id: original.stored.id } });
    expect(stored).toMatchObject({
      accessMode: "password",
      passwordVersion: original.stored.passwordVersion + 1,
      currentRevisionId: task.revisionId,
    });
    const result = await f.service.status({ ownerUserId: f.owner.id, uploadId: task.id });
    expect(await f.crypto.verify(result.accessPassword, stored.passwordHash)).toBe(true);
    expect(await f.db.auditLog.count({ where: { actorUserId: f.owner.id } })).toBe(0);
  });

  it("validates a concurrent homepage choice against whichever revision holds the row lock", async () => {
    const f = current();
    const original = await f.project();
    const replacement = await f.service.prepare(
      f.request({
        action: "replace",
        projectId: original.prepared.projectId,
        files: manifest(["next.html"]),
      }),
    );
    const task = await f.ready(replacement);
    let homepage;
    let published;
    try {
      published = await interleaveProject(
        f,
        original.stored.id,
        () => f.second.uploads.publishUpload({ uploadId: task.id, now: f.now }),
        async () => {},
        async () => {
          homepage = f.repositories.projects.setOwnedHomepage({
            ownerUserId: f.owner.id,
            projectKey: original.prepared.projectId,
            relativePath: "next.html",
          });
          await waitForProjectWait(f, 2);
        },
      );
    } finally {
      await Promise.allSettled([homepage]);
    }
    expect(published).toBe(true);
    expect(["updated", "invalid_file"]).toContain(await homepage);
    const stored = await f.db.demoProject.findUniqueOrThrow({ where: { id: original.stored.id } });
    expect(stored).toMatchObject({
      currentRevisionId: task.revisionId,
      homepagePath: (await homepage) === "updated" ? "next.html" : null,
    });
    expect(
      (
        await f.repositories.projects.findOwnedActiveProject({
          ownerUserId: f.owner.id,
          projectKey: original.prepared.projectId,
        })
      ).files,
    ).toEqual([{ relativePath: "next.html", size: 3 }]);
  });

  it("serializes a real publisher and deleter and includes all staged/published keys in cleanup", async () => {
    const f = current();
    const original = await f.project({ accessMode: "password" });
    const replacement = await f.service.prepare(
      f.request({
        action: "replace",
        projectId: original.prepared.projectId,
        files: manifest(["next.html"]),
        regeneratePassword: true,
      }),
    );
    const task = await f.ready(replacement);
    let deleting;
    let published;
    try {
      published = await interleaveProject(
        f,
        original.stored.id,
        () => f.second.uploads.publishUpload({ uploadId: task.id, now: f.now }),
        async () => {},
        async () => {
          deleting = f.repositories.deletion.deleteAsOwner({
            ownerUserId: f.owner.id,
            projectKey: original.prepared.projectId,
            now: f.now,
          });
          await waitForProjectWait(f, 2);
        },
      );
    } finally {
      await Promise.allSettled([deleting]);
    }
    expect(typeof published).toBe("boolean");
    expect(await deleting).toBe("deleted");
    const stored = await f.db.demoProject.findUniqueOrThrow({ where: { id: original.stored.id } });
    expect(stored).toMatchObject({
      status: "DELETED",
      currentRevisionId: null,
      accessMode: "organization",
      passwordHash: null,
      encryptedPassword: null,
      fileCount: 0,
      totalSize: 0n,
    });
    expect(
      await f.repositories.projects.findOwnedActiveProject({
        ownerUserId: f.owner.id,
        projectKey: original.prepared.projectId,
      }),
    ).toBeNull();
    expect(
      await f.db.quotaReservation.count({ where: { userId: f.owner.id, status: "RESERVED" } }),
    ).toBe(0);
    expect(
      await f.db.uploadTask.count({
        where: { projectId: stored.id, status: { in: ["PREPARED", "PROCESSING"] } },
      }),
    ).toBe(0);
    const cleanup = await f.db.cleanupJob.findFirstOrThrow({
      where: { kind: "PROJECT", targetId: stored.id },
    });
    expect(new Set(cleanup.objectKeys)).toEqual(
      new Set([...original.prepared.files, ...replacement.files].map((file) => file.storageKey)),
    );
  });
});
