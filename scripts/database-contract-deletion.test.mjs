import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

import { databaseContract } from "./database-contract-fixture.mjs";

databaseContract("owner deletion and deferred metadata cleanup", (current) => {
  it("denies another owner, tombstones atomically and cleans subordinate metadata after storage succeeds", async () => {
    const f = current();
    const original = await f.project({ accessMode: "password" });
    const input = { projectKey: original.prepared.projectId, now: f.now, ownerUserId: f.owner.id };
    const path = { projectKey: original.prepared.projectId, relativePath: "index.html" };
    const grant = await f.access.verifyPassword({
      ...path,
      password: original.result.accessPassword,
    });
    expect(
      await f.repositories.deletion.deleteAsOwner({ ...input, ownerUserId: randomUUID() }),
    ).toBe("forbidden");
    expect(
      await f.db.demoProject.findUniqueOrThrow({ where: { id: original.stored.id } }),
    ).toMatchObject({ status: "ACTIVE" });
    expect(await f.repositories.deletion.deleteAsOwner(input)).toBe("deleted");
    expect(await f.repositories.deletion.deleteAsOwner(input)).toBe("already_deleted");
    expect(await f.access.authorize({ ...path, token: grant.token })).toBeNull();
    expect(await f.access.authorize({ ...path, tenantId: f.tenant.id })).toBeNull();
    expect(
      await f.service.status({ ownerUserId: f.owner.id, uploadId: original.prepared.uploadId }),
    ).toMatchObject({ passwordStatus: "unavailable" });
    expect(await f.db.passwordAccessGrant.count({ where: { projectId: original.stored.id } })).toBe(
      0,
    );
    const cleanup = await f.db.cleanupJob.findFirstOrThrow({
      where: { kind: "PROJECT", targetId: original.stored.id },
    });
    expect(cleanup.runAfter).toEqual(new Date(original.prepared.expiresAt.getTime() + 60_000));
    expect(
      await f.repositories.cleanup.claimNextCleanupJob(new Date(cleanup.runAfter.getTime() - 1)),
    ).toBeNull();
    const claim = await f.repositories.cleanup.claimNextCleanupJob(cleanup.runAfter);
    expect(claim).toMatchObject({ id: cleanup.id, kind: "project", attemptCount: 1 });
    expect(new Set(claim.objectKeys)).toEqual(
      new Set(original.prepared.files.map((file) => file.storageKey)),
    );
    await f.repositories.cleanup.completeCleanupJob({
      id: claim.id,
      kind: claim.kind,
      claimAttempt: claim.attemptCount,
      now: cleanup.runAfter,
    });
    expect(
      await f.db.demoProject.findUniqueOrThrow({ where: { id: original.stored.id } }),
    ).toMatchObject({ status: "DELETED", currentRevisionId: null, fileCount: 0, totalSize: 0n });
    expect(await f.db.revision.count({ where: { projectId: original.stored.id } })).toBe(0);
    expect(await f.db.uploadTask.count({ where: { projectId: original.stored.id } })).toBe(0);
    expect(await f.db.fileObject.count({ where: { projectId: original.stored.id } })).toBe(0);
    expect(await f.repositories.orphanSweep.referencedObjectKeys(claim.objectKeys)).toEqual(
      new Set(),
    );
    expect(
      await f.db.auditLog.count({ where: { actorUserId: f.owner.id, action: "PROJECT_DELETE" } }),
    ).toBe(0);
  });
});
