import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

import { databaseContract, manifest } from "./database-contract-fixture.mjs";

databaseContract("publication, passwords and exact paths", (current) => {
  it("publishes and independently reads Unicode, case and 1024-unit paths without truncation", async () => {
    const f = current();
    const paths = [
      "中文😀/A.html",
      "中文😀/a.html",
      `${"x".repeat(1018)}A.html`,
      `${"x".repeat(1018)}B.html`,
      "assets/style.css",
    ];
    const { prepared, stored } = await f.project({ files: manifest(paths) });
    const detail = await f.repositories.projects.findOwnedActiveProject({
      ownerUserId: f.owner.id,
      projectKey: prepared.projectId,
    });
    expect(detail).toMatchObject({ projectKey: prepared.projectId, fileCount: 5, totalSize: 15 });
    expect(detail.files.map((file) => file.relativePath).sort()).toEqual([...paths].sort());
    for (const relativePath of paths) {
      const file = await f.repositories.projects.findCurrentFile({
        tenantId: f.tenant.id,
        projectKey: prepared.projectId,
        relativePath,
      });
      expect(file).toMatchObject({ relativePath, size: 3 });
      expect(file.storageKey.endsWith(relativePath)).toBe(true);
    }
    expect(
      await f.repositories.projects.findCurrentFile({
        tenantId: f.tenant.id,
        projectKey: prepared.projectId,
        relativePath: "中文😀/A.HTML",
      }),
    ).toBeNull();
    expect(
      await f.repositories.projects.findCurrentFile({
        tenantId: randomUUID(),
        projectKey: prepared.projectId,
        relativePath: paths[0],
      }),
    ).toBeNull();
    expect(
      await f.repositories.projects.findOwnedActiveProject({
        ownerUserId: randomUUID(),
        projectKey: prepared.projectId,
      }),
    ).toBeNull();
    const listed = await f.repositories.projects.listOwnedActiveProjects({
      ownerUserId: f.owner.id,
    });
    expect(listed.quota).toEqual({ projectCount: 1, storageBytes: 15 });
    expect(listed.projects[0].htmlPaths.sort()).toEqual(paths.slice(0, 4).sort());
    const homepage = { ownerUserId: f.owner.id, projectKey: prepared.projectId };
    expect(
      await f.repositories.projects.setOwnedHomepage({ ...homepage, relativePath: paths[1] }),
    ).toBe("updated");
    expect(
      await f.repositories.projects.setOwnedHomepage({
        ...homepage,
        relativePath: "assets/style.css",
      }),
    ).toBe("invalid_file");
    expect(
      await f.repositories.projects.setOwnedHomepage({ ...homepage, relativePath: "missing.html" }),
    ).toBe("invalid_file");
    expect(
      (await f.db.demoProject.findUniqueOrThrow({ where: { id: stored.id } })).homepagePath,
    ).toBe(paths[1]);
    expect(
      await f.repositories.projects.setOwnedHomepage({ ...homepage, relativePath: null }),
    ).toBe("updated");
    expect(
      (await f.db.demoProject.findUniqueOrThrow({ where: { id: stored.id } })).homepagePath,
    ).toBeNull();
  });

  it("activates password material with content, retains it on replacement and preserves it on failure", async () => {
    const f = current();
    const original = await f.project({ accessMode: "password" });
    expect(original.result).toMatchObject({ accessMode: "password", passwordStatus: "generated" });
    expect(
      await f.crypto.verify(original.result.accessPassword, original.stored.passwordHash),
    ).toBe(true);
    const path = { projectKey: original.prepared.projectId, relativePath: "index.html" };
    const grant = await f.access.verifyPassword({
      ...path,
      password: original.result.accessPassword,
    });
    expect(grant).not.toBeNull();
    expect(await f.access.authorize({ ...path, token: grant.token })).not.toBeNull();
    expect(await f.access.authorize({ ...path, tenantId: f.tenant.id })).not.toBeNull();
    expect(await f.access.authorize({ ...path, tenantId: randomUUID() })).toBeNull();
    const replacement = await f.service.prepare(
      f.request({ action: "replace", projectId: path.projectKey }),
    );
    expect(await f.publish(replacement)).toMatchObject({
      accessMode: "password",
      passwordStatus: "retained",
    });
    const retained = await f.db.demoProject.findUniqueOrThrow({
      where: { id: original.stored.id },
    });
    expect(retained.passwordHash).toBe(original.stored.passwordHash);
    const failed = await f.service.prepare(
      f.request({ action: "replace", projectId: path.projectKey, regeneratePassword: true }),
    );
    expect(
      (await f.db.demoProject.findUniqueOrThrow({ where: { id: retained.id } })).passwordVersion,
    ).toBe(retained.passwordVersion);
    expect(
      await f.repositories.uploads.failUpload({
        uploadId: failed.uploadId,
        failureCode: "contract_verification_failure",
        now: f.now,
      }),
    ).toBe(true);
    const persisted = await f.db.demoProject.findUniqueOrThrow({ where: { id: retained.id } });
    expect(persisted).toMatchObject({
      currentRevisionId: retained.currentRevisionId,
      passwordHash: retained.passwordHash,
      encryptedPassword: retained.encryptedPassword,
      passwordVersion: retained.passwordVersion,
      status: "ACTIVE",
    });
    expect(await f.access.authorize({ ...path, token: grant.token })).not.toBeNull();
    expect(
      await f.service.status({ ownerUserId: f.owner.id, uploadId: failed.uploadId }),
    ).not.toHaveProperty("accessPassword");
    expect(
      await f.repositories.uploads.publishUpload({ uploadId: failed.uploadId, now: f.now }),
    ).toBe(false);
  });

  it("rotates atomically, revokes old grants/results, then disables password access", async () => {
    const f = current();
    const original = await f.project({ accessMode: "password" });
    const path = { projectKey: original.prepared.projectId, relativePath: "index.html" };
    const grant = await f.access.verifyPassword({
      ...path,
      password: original.result.accessPassword,
    });
    const replacement = await f.service.prepare(
      f.request({ action: "replace", projectId: path.projectKey, regeneratePassword: true }),
    );
    expect(
      (await f.db.demoProject.findUniqueOrThrow({ where: { id: original.stored.id } }))
        .currentRevisionId,
    ).toBe(original.stored.currentRevisionId);
    const result = await f.publish(replacement);
    expect(result.passwordStatus).toBe("generated");
    expect(
      await f.management.readOwnedProjectAccess({
        ownerUserId: f.owner.id,
        projectKey: path.projectKey,
      }),
    ).toMatchObject({ accessPassword: result.accessPassword, passwordStatus: "available" });
    expect(await f.access.authorize({ ...path, token: grant.token })).toBeNull();
    expect(
      await f.service.status({ ownerUserId: f.owner.id, uploadId: original.prepared.uploadId }),
    ).toMatchObject({ passwordStatus: "unavailable" });
    const disabled = await f.management.changeOwnedProjectAccess({
      action: "disable",
      ownerUserId: f.owner.id,
      projectKey: path.projectKey,
      requestIp: "127.0.0.1",
      traceId: randomUUID(),
    });
    expect(disabled).toMatchObject({
      outcome: "updated",
      access: { accessMode: "organization", passwordStatus: "disabled" },
    });
    expect(await f.access.authorize({ ...path, tenantId: f.tenant.id })).not.toBeNull();
    expect(await f.access.authorize({ ...path, token: grant.token })).toBeNull();
    expect(
      await f.db.auditLog.count({
        where: { actorUserId: f.owner.id, action: "PASSWORD_ACCESS_DISABLE" },
      }),
    ).toBe(1);
  });

  it("enforces exact grant/result expiry and cleans transient credentials without destroying the project", async () => {
    const f = current();
    const original = await f.project({ accessMode: "password" });
    const path = { projectKey: original.prepared.projectId, relativePath: "index.html" };
    const grant = await f.access.verifyPassword({
      ...path,
      password: original.result.accessPassword,
    });
    f.setNow(new Date(grant.expiresAt.getTime() - 1));
    expect(await f.access.authorize({ ...path, token: grant.token })).not.toBeNull();
    f.setNow(grant.expiresAt);
    expect(await f.access.authorize({ ...path, token: grant.token })).toBeNull();
    const task = await f.db.uploadTask.findUniqueOrThrow({
      where: { id: original.prepared.uploadId },
    });
    const expiresAt = task.passwordResultExpiresAt;
    expect(
      await f.repositories.uploads.getStatus({
        ownerUserId: f.owner.id,
        uploadId: task.id,
        now: new Date(expiresAt.getTime() - 1),
      }),
    ).toHaveProperty("accessPassword");
    expect(
      await f.repositories.uploads.getStatus({
        ownerUserId: f.owner.id,
        uploadId: task.id,
        now: expiresAt,
      }),
    ).toMatchObject({ passwordStatus: "unavailable" });
    expect(await f.repositories.passwordCleanup.cleanupExpired(expiresAt)).toMatchObject({
      results: 1,
      grants: 1,
    });
    expect(await f.db.uploadTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      encryptedPasswordResult: null,
      pendingPasswordHash: null,
      passwordResultExpiresAt: null,
    });
    expect(
      await f.db.demoProject.findUniqueOrThrow({ where: { id: original.stored.id } }),
    ).toMatchObject({
      status: "ACTIVE",
      passwordHash: original.stored.passwordHash,
      encryptedPassword: original.stored.encryptedPassword,
    });
  });
});
