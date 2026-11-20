import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

import { databaseContract, manifest } from "./database-contract-fixture.mjs";

databaseContract("optional uploaded cover publication", (current) => {
  it("binds a signed declaration to the owner, task, exact bytes and project revision", async () => {
    const f = current();
    const prepared = await f.service.prepare(f.request());
    expect(prepared.coverHomepage).toBe("index.html");
    const args = coverArgs(f, prepared);
    const other = { ...args, ownerUserId: randomUUID(), now: f.now };
    await expect(f.second.uploads.prepareCover(other)).rejects.toMatchObject({
      code: "UPLOAD_NOT_FOUND",
    });
    const results = await Promise.allSettled([
      f.service.prepareCover(args),
      f.second.uploads.prepareCover({ ...args, size: 11, now: f.now }),
    ]);
    const accepted = results.filter((result) => result.status === "fulfilled");
    expect(accepted).toHaveLength(1);
    const [first] = accepted.map(({ value }) => value);
    expect(first.storageKey).toMatch(
      new RegExp(`^square-covers/[^/]+/${prepared.uploadId}\\.jpg$`),
    );
    expect(await f.service.prepareCover({ ...args, size: first.size })).toEqual(first);

    const task = await f.ready(prepared);
    await expect(f.service.prepareCover(args)).rejects.toMatchObject({
      code: "INVALID_UPLOAD_INPUT",
    });
    expect(task.coverStorageKey).toBe(first.storageKey);
    expect(
      await f.db.projectSquareCover.findUnique({ where: { projectId: task.projectId } }),
    ).toBeNull();
    expect(
      await f.repositories.uploads.publishUpload({
        now: f.now,
        uploadId: prepared.uploadId,
        verifiedCoverKey: first.storageKey,
      }),
    ).toBe(true);
    expect(
      await f.db.projectSquareCover.findUnique({ where: { projectId: task.projectId } }),
    ).toMatchObject({
      homepagePath: first.homepagePath,
      privateImageKey: first.storageKey,
      revisionId: task.revisionId,
      status: "ready",
      tenantId: task.tenantId,
    });
  });

  it("uses the configured homepage and atomically clears an old cover after homepage drift", async () => {
    const f = current();
    const files = manifest(["index.html", "manual.html"]);
    const created = await f.service.prepare(f.request({ files }));
    const first = await f.service.prepareCover(coverArgs(f, created));
    const task = await f.ready(created);
    expect(
      await f.repositories.uploads.publishUpload({
        now: f.now,
        uploadId: created.uploadId,
        verifiedCoverKey: first.storageKey,
      }),
    ).toBe(true);

    const where = { id: task.projectId };
    const coverWhere = { projectId: task.projectId };
    await f.db.demoProject.update({ where, data: { homepagePath: "manual.html" } });
    const replacement = await f.service.prepare(
      f.request({ action: "replace", projectId: created.projectId, files }),
    );
    expect(replacement.coverHomepage).toBe("manual.html");
    const args = coverArgs(f, replacement);
    await expect(
      f.service.prepareCover({ ...args, homepagePath: "index.html" }),
    ).rejects.toMatchObject({ code: "INVALID_UPLOAD_INPUT" });
    const second = await f.service.prepareCover(args);
    expect(await f.db.projectSquareCover.findUnique({ where: coverWhere })).toMatchObject({
      privateImageKey: first.storageKey,
    });

    // The project homepage changed while the new revision was being uploaded.
    await f.db.demoProject.update({ where, data: { homepagePath: "index.html" } });
    const next = await f.ready(replacement);
    expect(
      await f.repositories.uploads.publishUpload({
        now: f.now,
        uploadId: replacement.uploadId,
        verifiedCoverKey: second.storageKey,
      }),
    ).toBe(true);
    expect(await f.db.projectSquareCover.findUnique({ where: coverWhere })).toBeNull();
    expect(await f.db.demoProject.findUnique({ where })).toMatchObject({
      currentRevisionId: next.revisionId,
    });
  });

  it("preserves a published cover after a failed or expired overwrite", async () => {
    const f = current();
    const created = await f.service.prepare(f.request());
    const first = await f.service.prepareCover(coverArgs(f, created));
    const task = await f.ready(created);
    expect(
      await f.repositories.uploads.publishUpload({
        now: f.now,
        uploadId: created.uploadId,
        verifiedCoverKey: first.storageKey,
      }),
    ).toBe(true);

    const request = f.request({ action: "replace", projectId: created.projectId });
    const failed = await f.service.prepare(request);
    const next = await f.service.prepareCover(coverArgs(f, failed));
    expect(
      await f.repositories.uploads.failUpload({
        now: f.now,
        uploadId: failed.uploadId,
        failureCode: "UPLOAD_OBJECT_MISSING",
      }),
    ).toBe(true);
    expect(
      await f.repositories.uploads.publishUpload({
        now: f.now,
        uploadId: failed.uploadId,
        verifiedCoverKey: next.storageKey,
      }),
    ).toBe(false);

    const pending = await f.service.prepare(request);
    expect(pending.uploadId).not.toBe(failed.uploadId);
    f.setNow(pending.expiresAt);
    await expect(f.service.prepareCover(coverArgs(f, pending))).rejects.toMatchObject({
      code: "UPLOAD_EXPIRED",
    });
    expect(
      await f.db.projectSquareCover.findUnique({ where: { projectId: task.projectId } }),
    ).toMatchObject({ privateImageKey: first.storageKey, revisionId: task.revisionId });
  });
});

function coverArgs(fixture, prepared) {
  return {
    uploadId: prepared.uploadId,
    ownerUserId: fixture.owner.id,
    homepagePath: prepared.coverHomepage,
    contentMd5: "kAFQmDzST7DWlj99KOF/cg==",
    size: 10,
  };
}
