import { expect, it } from "vitest";

import { databaseContract, manifest } from "./database-contract-fixture.mjs";

databaseContract("idempotency and quota reservations", (current) => {
  it("returns one upload for concurrent identical requests and rejects a changed request", async () => {
    const f = current();
    const request = f.request();
    const results = await Promise.all([
      f.service.prepare(request),
      f.second.uploads.prepare({ ...request, fileCount: 1, totalSize: 3, now: f.now }),
      f.service.prepare(request),
    ]);
    expect(new Set(results.map((result) => result.uploadId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotent)).toHaveLength(1);
    expect(await f.db.uploadTask.count({ where: { ownerUserId: f.owner.id } })).toBe(1);
    expect(
      await f.db.quotaReservation.count({ where: { userId: f.owner.id, status: "RESERVED" } }),
    ).toBe(1);
    await expect(f.service.prepare({ ...request, displayName: "Changed" })).rejects.toMatchObject({
      code: "INVALID_UPLOAD_INPUT",
    });
    await f.publish(results[0]);
    expect(await f.service.prepare(request)).toMatchObject({
      uploadId: results[0].uploadId,
      idempotent: true,
      status: "completed",
    });
  });

  it("admits only one of two creations with 99 active projects and still permits replacement", async () => {
    const f = current();
    const keys = await f.seedActive(99);
    const second = f.request();
    const results = await Promise.allSettled([
      f.service.prepare(f.request()),
      f.second.uploads.prepare({ ...second, fileCount: 1, totalSize: 3, now: f.now }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected").reason).toMatchObject({
      code: "PROJECT_QUOTA_EXCEEDED",
    });
    expect(
      await f.db.quotaReservation.count({ where: { userId: f.owner.id, status: "RESERVED" } }),
    ).toBe(1);
    expect(
      await f.service.prepare(f.request({ action: "replace", projectId: keys[0] })),
    ).toMatchObject({ status: "prepared", projectId: keys[0] });
  });

  it("serializes 2 GiB storage reservations exactly and releases failed and expired reservations", async () => {
    const f = current();
    await f.seedActive(1, 2n * 1024n ** 3n - 3n);
    const request = f.request();
    const results = await Promise.allSettled([
      f.service.prepare(request),
      f.second.uploads.prepare({ ...f.request(), fileCount: 1, totalSize: 3, now: f.now }),
    ]);
    const success = results.find((result) => result.status === "fulfilled").value;
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected").reason).toMatchObject({
      code: "STORAGE_QUOTA_EXCEEDED",
    });
    const reservation = await f.db.quotaReservation.findUniqueOrThrow({
      where: { uploadTaskId: success.uploadId },
    });
    expect(reservation.storageBytes).toBe(3n);
    await f.repositories.uploads.failUpload({
      uploadId: success.uploadId,
      failureCode: "contract_failure",
      now: f.now,
    });
    const next = await f.service.prepare(f.request());
    f.setNow(next.expiresAt);
    expect(
      await f.service.status({ ownerUserId: f.owner.id, uploadId: next.uploadId }),
    ).toMatchObject({ status: "expired" });
    expect(
      await f.db.quotaReservation.count({ where: { userId: f.owner.id, status: "RESERVED" } }),
    ).toBe(0);
    expect(await f.service.prepare(f.request())).toMatchObject({ status: "prepared" });
  });

  it("rechecks create quotas on a failed idempotent retry instead of bypassing the 100-project limit", async () => {
    const f = current();
    const request = f.request();
    const failed = await f.service.prepare(request);
    await f.repositories.uploads.failUpload({
      uploadId: failed.uploadId,
      failureCode: "contract_failure",
      now: f.now,
    });
    await f.seedActive(100);
    await expect(f.service.prepare(request)).rejects.toMatchObject({
      code: "PROJECT_QUOTA_EXCEEDED",
    });
    expect(await f.db.uploadTask.count({ where: { ownerUserId: f.owner.id } })).toBe(1);
    expect(
      await f.db.quotaReservation.count({ where: { userId: f.owner.id, status: "RESERVED" } }),
    ).toBe(0);
  });

  it("reuses a failed create's reserved project within its idempotency window", async () => {
    const f = current();
    const request = f.request();
    const first = await f.service.prepare(request);
    await f.repositories.uploads.failUpload({
      uploadId: first.uploadId,
      failureCode: "retryable",
      now: f.now,
    });
    f.setNow(new Date(f.now.getTime() + 10 * 60_000));
    const retry = await f.service.prepare(request);
    expect(retry).toMatchObject({
      projectId: first.projectId,
      revisionNumber: 2,
      idempotent: false,
    });
    expect(retry.uploadId).not.toBe(first.uploadId);
    expect(await f.db.demoProject.count({ where: { ownerUserId: f.owner.id } })).toBe(1);
    expect(
      await f.db.quotaReservation.count({ where: { userId: f.owner.id, status: "RESERVED" } }),
    ).toBe(1);
  });

  it("opens a fresh idempotency window at exactly 24 hours while preserving the published project", async () => {
    const f = current();
    const request = f.request();
    const first = await f.service.prepare(request);
    await f.publish(first);
    const task = await f.db.uploadTask.findUniqueOrThrow({ where: { id: first.uploadId } });
    f.setNow(new Date(task.createdAt.getTime() + 86_400_000 - 1));
    expect(await f.service.prepare(request)).toMatchObject({
      uploadId: first.uploadId,
      idempotent: true,
    });
    f.setNow(new Date(task.createdAt.getTime() + 86_400_000));
    const next = await f.service.prepare(request);
    expect(next.idempotent).toBe(false);
    expect(next.projectId).not.toBe(first.projectId);
    expect(
      await f.db.demoProject.findUniqueOrThrow({ where: { projectKey: first.projectId } }),
    ).toMatchObject({ status: "ACTIVE", currentRevisionId: task.revisionId });
  });

  it("accepts exact 5 MiB/20 MiB/500-file limits and rejects their next increment", async () => {
    const f = current();
    const size = 5 * 1024 * 1024;
    const files = manifest(["1.html", "2.html", "3.html", "4.html"], size);
    const prepared = await f.service.prepare(f.request({ files }));
    expect(prepared.files.reduce((sum, file) => sum + file.size, 0)).toBe(20 * 1024 * 1024);
    await f.repositories.uploads.failUpload({
      uploadId: prepared.uploadId,
      failureCode: "contract_done",
      now: f.now,
    });
    await expect(
      f.service.prepare(f.request({ files: manifest(["index.html"], size + 1) })),
    ).rejects.toMatchObject({ code: "INVALID_UPLOAD_INPUT" });
    await expect(
      f.service.prepare(f.request({ files: [...files, ...manifest(["5.html"], 1)] })),
    ).rejects.toMatchObject({ code: "INVALID_UPLOAD_INPUT" });
    const paths = Array.from({ length: 500 }, (_, index) => `${index}.html`);
    const maximum = await f.service.prepare(f.request({ files: manifest(paths, 0) }));
    expect(maximum.files).toHaveLength(500);
    await expect(
      f.service.prepare(f.request({ files: manifest([...paths, "501.html"], 0) })),
    ).rejects.toMatchObject({ code: "INVALID_UPLOAD_INPUT" });
  });
});
