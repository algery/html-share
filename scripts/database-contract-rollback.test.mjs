import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

import { databaseContract } from "./database-contract-fixture.mjs";

databaseContract("rollback and driver error boundaries", (current) => {
  it("rolls back file writes, revision activation, password/grant changes and settlement on a late constraint failure", async () => {
    const f = current();
    const original = await f.project({ accessMode: "password" });
    const grant = await f.db.passwordAccessGrant.create({
      data: {
        tenantId: f.tenant.id,
        projectId: original.stored.id,
        passwordVersion: original.stored.passwordVersion,
        grantHash: randomUUID(),
        expiresAt: new Date(f.now.getTime() + 60_000),
      },
    });
    const replacement = await f.service.prepare(
      f.request({
        action: "replace",
        projectId: original.prepared.projectId,
        regeneratePassword: true,
      }),
    );
    const task = await f.ready(replacement);
    // A different row holds the unique current_revision_id. Publication writes
    // file objects and both revisions before this final project switch fails.
    await f.db.demoProject.create({
      data: {
        tenantId: f.tenant.id,
        ownerUserId: f.owner.id,
        projectKey: randomUUID().slice(0, 5),
        displayName: "Constraint holder",
        currentRevisionId: task.revisionId,
      },
    });
    const error = await f.repositories.uploads
      .publishUpload({ uploadId: task.id, now: f.now })
      .catch((failure) => failure);
    expect(error).toMatchObject({ name: "DatabaseOperationError" });
    expect(error.message).not.toMatch(
      /P2002|1062|23505|INSERT|UPDATE|postgres|mysql|password|phase25-local-test/i,
    );
    expect(await f.db.fileObject.count({ where: { revisionId: task.revisionId } })).toBe(0);
    expect(
      await f.db.demoProject.findUniqueOrThrow({ where: { id: original.stored.id } }),
    ).toMatchObject({
      currentRevisionId: original.stored.currentRevisionId,
      passwordHash: original.stored.passwordHash,
      passwordVersion: original.stored.passwordVersion,
      encryptedPassword: original.stored.encryptedPassword,
    });
    expect(
      await f.db.revision.findUniqueOrThrow({ where: { id: original.stored.currentRevisionId } }),
    ).toMatchObject({ status: "ACTIVE", cleanupAfter: null });
    expect(await f.db.revision.findUniqueOrThrow({ where: { id: task.revisionId } })).toMatchObject(
      { status: "PENDING", publishedAt: null },
    );
    expect(
      await f.db.passwordAccessGrant.findUniqueOrThrow({ where: { id: grant.id } }),
    ).toMatchObject({ revokedAt: null });
    expect(await f.db.uploadTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      status: "PROCESSING",
      completedAt: null,
    });
    expect(
      await f.db.quotaReservation.findUniqueOrThrow({ where: { uploadTaskId: task.id } }),
    ).toMatchObject({ status: "RESERVED", settledAt: null });
  });
});
