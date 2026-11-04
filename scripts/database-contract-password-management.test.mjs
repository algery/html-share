import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

import { databaseContract } from "./database-contract-fixture.mjs";

databaseContract("owner password management lifecycle", (current) => {
  it("enables, refuses active-upload conflicts, rotates and disables with grant revocation and audits", async () => {
    const f = current();
    const original = await f.project();
    const path = { projectKey: original.prepared.projectId, relativePath: "index.html" };
    const change = (action, ownerUserId = f.owner.id) =>
      f.management.changeOwnedProjectAccess({
        action,
        ownerUserId,
        projectKey: path.projectKey,
        requestIp: "127.0.0.1",
        traceId: randomUUID(),
      });
    expect(await change("enable", randomUUID())).toEqual({ outcome: "not_found" });
    const enabled = await change("enable");
    expect(enabled).toMatchObject({
      outcome: "updated",
      access: { accessMode: "password", passwordStatus: "available" },
    });
    expect(
      await f.management.readOwnedProjectAccess({
        ownerUserId: f.owner.id,
        projectKey: path.projectKey,
      }),
    ).toEqual(enabled.access);
    const grant = await f.access.verifyPassword({
      ...path,
      password: enabled.access.accessPassword,
    });
    expect(grant).not.toBeNull();
    const replacement = await f.service.prepare(
      f.request({ action: "replace", projectId: path.projectKey }),
    );
    const before = await f.db.demoProject.findUniqueOrThrow({ where: { id: original.stored.id } });
    expect(await change("regenerate")).toEqual({ outcome: "upload_conflict" });
    expect(
      await f.db.demoProject.findUniqueOrThrow({ where: { id: original.stored.id } }),
    ).toMatchObject({ passwordVersion: before.passwordVersion, passwordHash: before.passwordHash });
    await f.repositories.uploads.failUpload({
      uploadId: replacement.uploadId,
      failureCode: "contract_done",
      now: f.now,
    });
    const rotated = await change("regenerate");
    expect(rotated).toMatchObject({
      outcome: "updated",
      access: { accessMode: "password", passwordStatus: "available" },
    });
    expect(await f.access.authorize({ ...path, token: grant.token })).toBeNull();
    expect(
      await f.access.verifyPassword({ ...path, password: rotated.access.accessPassword }),
    ).not.toBeNull();
    expect(await change("disable")).toMatchObject({
      outcome: "updated",
      access: { accessMode: "organization", passwordStatus: "disabled" },
    });
    expect(
      await f.db.demoProject.findUniqueOrThrow({ where: { id: original.stored.id } }),
    ).toMatchObject({
      currentRevisionId: original.stored.currentRevisionId,
      passwordHash: null,
      encryptedPassword: null,
      accessMode: "organization",
    });
    const audits = await f.db.auditLog.findMany({
      where: { actorUserId: f.owner.id },
      select: { action: true },
    });
    expect(audits.map((audit) => audit.action).sort()).toEqual([
      "PASSWORD_ACCESS_DISABLE",
      "PASSWORD_ACCESS_ENABLE",
      "PASSWORD_ACCESS_REGENERATE",
    ]);
  });
});
