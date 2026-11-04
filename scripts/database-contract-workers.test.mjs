import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

import { databaseContract } from "./database-contract-fixture.mjs";

databaseContract("multi-worker claiming, leases and stale fencing", (current) => {
  it("claims processing tasks once and expires crashed uploads using their real five-minute lifetime", async () => {
    const f = current();
    const first = await f.service.prepare(f.request());
    const next = await f.service.prepare(f.request());
    await f.ready(first);
    await f.ready(next);
    const claims = (
      await Promise.all([
        f.repositories.uploads.claimNextProcessingUpload(f.now),
        f.second.uploads.claimNextProcessingUpload(f.now),
      ])
    ).filter(Boolean);
    // SKIP LOCKED may temporarily find no candidate during the other scan.
    // After both transactions commit every remaining task must be claimable.
    while (claims.length < 2) {
      const remaining = await f.repositories.uploads.claimNextProcessingUpload(f.now);
      expect(remaining).not.toBeNull();
      claims.push(remaining);
    }
    expect(new Set(claims.map((claim) => claim.uploadId))).toEqual(
      new Set([first.uploadId, next.uploadId]),
    );
    expect(await f.repositories.uploads.claimNextProcessingUpload(f.now)).toBeNull();
    // Do not extend production's five-minute upload lifetime just to make a
    // ten-minute reclaim possible. A crashed upload is expired when its lease
    // can be recovered; cleanup/sweep leases are tested separately below.
    const reclaimAt = new Date(f.now.getTime() + 10 * 60_000);
    expect(await f.second.uploads.claimNextProcessingUpload(reclaimAt)).toBeNull();
    for (const task of [first, next]) {
      expect(
        await f.db.uploadTask.findUniqueOrThrow({ where: { id: task.uploadId } }),
      ).toMatchObject({ status: "EXPIRED" });
      expect(
        await f.db.quotaReservation.findUniqueOrThrow({ where: { uploadTaskId: task.uploadId } }),
      ).toMatchObject({ status: "RELEASED" });
      expect(
        await f.second.uploads.publishUpload({ uploadId: task.uploadId, now: reclaimAt }),
      ).toBe(false);
    }
  });

  it("claims cleanup jobs uniquely and fences both stale completion and stale retry", async () => {
    const f = current();
    const stateDigest = randomUUID();
    f.stateDigests.push(stateDigest);
    const state = await f.db.authState.create({
      data: { stateDigest, audience: "APP", returnPath: "/", expiresAt: f.now },
    });
    f.targets.push(state.id);
    const target = randomUUID();
    f.targets.push(target);
    await f.db.cleanupJob.createMany({
      data: [state.id, target].map((targetId) => ({
        kind: "AUTH_STATE",
        targetId,
        objectKeys: [],
        runAfter: f.now,
      })),
    });
    const claims = (
      await Promise.all([
        f.repositories.cleanup.claimNextCleanupJob(f.now),
        f.second.cleanup.claimNextCleanupJob(f.now),
      ])
    ).filter(Boolean);
    while (claims.length < 2) {
      const remaining = await f.repositories.cleanup.claimNextCleanupJob(f.now);
      expect(remaining).not.toBeNull();
      claims.push(remaining);
    }
    expect(new Set(claims.map((claim) => claim.id)).size).toBe(2);
    expect(claims.map((claim) => claim.attemptCount)).toEqual([1, 1]);
    expect(await f.repositories.cleanup.claimNextCleanupJob(f.now)).toBeNull();
    const stateJob = await f.db.cleanupJob.findFirstOrThrow({
      where: { kind: "AUTH_STATE", targetId: state.id },
    });
    const original = claims.find((claim) => claim.id === stateJob.id);
    const other = claims.find((claim) => claim.id !== stateJob.id);
    await f.repositories.cleanup.completeCleanupJob({
      ...other,
      claimAttempt: other.attemptCount,
      now: f.now,
    });
    const reclaimAt = new Date(f.now.getTime() + 10 * 60_000);
    const reclaimed = await f.second.cleanup.claimNextCleanupJob(reclaimAt);
    expect(reclaimed).toMatchObject({ id: stateJob.id, attemptCount: 2 });
    await f.repositories.cleanup.completeCleanupJob({
      ...original,
      claimAttempt: original.attemptCount,
      now: reclaimAt,
    });
    await f.repositories.cleanup.retryCleanupJob({
      id: original.id,
      claimAttempt: original.attemptCount,
      errorCode: "stale",
      now: reclaimAt,
    });
    expect(await f.db.authState.findUnique({ where: { id: state.id } })).not.toBeNull();
    expect(await f.db.cleanupJob.findUniqueOrThrow({ where: { id: stateJob.id } })).toMatchObject({
      status: "RUNNING",
      attemptCount: 2,
      lastError: null,
    });
    await f.second.cleanup.retryCleanupJob({
      id: reclaimed.id,
      claimAttempt: reclaimed.attemptCount,
      errorCode: "retry",
      now: reclaimAt,
    });
    const retried = await f.db.cleanupJob.findUniqueOrThrow({ where: { id: stateJob.id } });
    expect(retried).toMatchObject({
      status: "RETRY",
      lastError: "retry",
      runAfter: new Date(reclaimAt.getTime() + 120_000),
    });
    expect(
      await f.repositories.cleanup.claimNextCleanupJob(new Date(retried.runAfter.getTime() - 1)),
    ).toBeNull();
    const final = await f.repositories.cleanup.claimNextCleanupJob(retried.runAfter);
    await f.repositories.cleanup.completeCleanupJob({
      ...final,
      claimAttempt: final.attemptCount,
      now: retried.runAfter,
    });
    expect(await f.db.authState.findUnique({ where: { id: state.id } })).toBeNull();
  });

  it("fences sweep continuation and retry by claimedAt after a crashed worker is replaced", async () => {
    const f = current();
    await f.db.objectSweepState.deleteMany({ where: { id: "projects" } });
    try {
      const claims = await Promise.all([
        f.repositories.orphanSweep.claimObjectSweep(f.now),
        f.second.orphanSweep.claimObjectSweep(f.now),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const first = claims.find(Boolean);
      const reclaimAt = new Date(f.now.getTime() + 10 * 60_000);
      const latest = await f.second.orphanSweep.claimObjectSweep(reclaimAt);
      expect(latest).toMatchObject({ claimedAt: reclaimAt });
      await f.repositories.orphanSweep.completeObjectSweep({
        claimedAt: first.claimedAt,
        nextContinuationToken: "stale",
        now: reclaimAt,
      });
      await f.repositories.orphanSweep.retryObjectSweep({
        claimedAt: first.claimedAt,
        now: reclaimAt,
      });
      expect(
        await f.db.objectSweepState.findUniqueOrThrow({ where: { id: "projects" } }),
      ).toMatchObject({ claimedAt: reclaimAt, continuationToken: null });
      await f.second.orphanSweep.completeObjectSweep({
        claimedAt: latest.claimedAt,
        nextContinuationToken: "中文😀/next",
        now: reclaimAt,
      });
      expect(await f.repositories.orphanSweep.claimObjectSweep(reclaimAt)).toMatchObject({
        continuationToken: "中文😀/next",
      });
    } finally {
      await f.db.objectSweepState.deleteMany({ where: { id: "projects" } });
    }
  });

  it("finds only exact full published and staged object keys", async () => {
    const f = current();
    const published = await f.project();
    const staged = await f.service.prepare(f.request());
    const keys = [...published.prepared.files, ...staged.files].map((file) => file.storageKey);
    const wrong = keys[0].replace("index.html", "Index.html");
    const requested = [...keys, wrong, `projects/不存在😀/${randomUUID()}`];
    expect(await f.repositories.orphanSweep.referencedObjectKeys(requested)).toEqual(new Set(keys));
    expect(await f.second.orphanSweep.referencedObjectKeys([])).toEqual(new Set());
  });
});
