import { describe, expect, it, vi } from "vitest";
import { enqueueCleanupJob } from "./cleanup-enqueue.js";
import { createMysqlCleanupRepository } from "./cleanup-repository.js";
import type { MysqlClient, MysqlTransactionClient } from "./types.js";

const now = new Date("2026-11-04T00:00:00Z");

function fixture() {
  const query = vi.fn().mockResolvedValue([]);
  const job = {
    id: "job",
    kind: "UPLOAD",
    targetId: "task",
    objectKeys: ["private/A.html"],
    status: "RUNNING",
    attemptCount: 2,
  };
  const find = vi.fn().mockImplementation(() => Promise.resolve(job));
  const update = vi.fn().mockImplementation(() => Promise.resolve(job));
  const updateTarget = vi.fn().mockResolvedValue({ count: 1 });
  const tx = {
    $queryRaw: query,
    cleanupJob: { findUnique: find, update },
    uploadTask: { updateMany: updateTarget },
  } as unknown as MysqlTransactionClient;
  const prisma = {
    $transaction: (operation: (client: MysqlTransactionClient) => Promise<unknown>) =>
      operation(tx),
  } as unknown as MysqlClient;
  return { repository: createMysqlCleanupRepository(prisma), query, job, update, updateTarget };
}

describe("MySQL cleanup lease fencing", () => {
  it.each(["complete", "retry"] as const)(
    "ignores stale lease %s after another worker reclaimed",
    async (action) => {
      const test = fixture();
      if (action === "complete") {
        await test.repository.completeCleanupJob({
          claimAttempt: 1,
          id: "job",
          kind: "upload",
          now,
        });
      } else {
        await test.repository.retryCleanupJob({
          claimAttempt: 1,
          id: "job",
          errorCode: "STORAGE_FAILED",
          now,
        });
      }
      expect(test.update).not.toHaveBeenCalled();
      expect(test.updateTarget).not.toHaveBeenCalled();
    },
  );

  it("completes the target once and rejects an already completed claim", async () => {
    const test = fixture();
    await test.repository.completeCleanupJob({ claimAttempt: 2, id: "job", kind: "upload", now });
    test.job.status = "COMPLETED";
    await test.repository.completeCleanupJob({ claimAttempt: 2, id: "job", kind: "upload", now });
    expect(test.updateTarget).toHaveBeenCalledTimes(1);
    expect(test.update).toHaveBeenCalledTimes(1);
  });

  it("does not mutate a target when the claimed kind does not match persisted kind", async () => {
    const test = fixture();
    await expect(
      test.repository.completeCleanupJob({ claimAttempt: 2, id: "job", kind: "project", now }),
    ).rejects.toThrow("CLEANUP_JOB_KIND_MISMATCH");
    expect(test.updateTarget).not.toHaveBeenCalled();
    expect(test.update).not.toHaveBeenCalled();
  });

  it("returns the incremented attempt as the claim fence", async () => {
    const test = fixture();
    test.query.mockResolvedValue([{ id: "job" }]);
    await expect(test.repository.claimNextCleanupJob(now)).resolves.toEqual({
      id: "job",
      attemptCount: 2,
      kind: "upload",
      objectKeys: ["private/A.html"],
    });
    expect(test.update).toHaveBeenCalledWith({
      data: { status: "RUNNING", attemptCount: { increment: 1 }, updatedAt: now },
      where: { id: "job" },
    });
  });
});

describe("MySQL cleanup target digest identity", () => {
  const input = { kind: "UPLOAD" as const, targetId: "目标🙂", objectKeys: [], runAfter: now };

  function enqueueFixture() {
    const query = vi.fn();
    const create = vi.fn();
    const tx = { $queryRaw: query, cleanupJob: { create } } as unknown as MysqlTransactionClient;
    return { query, create, tx };
  }

  it("rejects an existing digest belonging to another full target", async () => {
    const test = enqueueFixture();
    test.query.mockResolvedValue([{ id: "other-job", targetId: "another-target" }]);
    await expect(enqueueCleanupJob(test.tx, input)).rejects.toMatchObject({
      name: "DatabaseOperationError",
    });
    expect(test.create).not.toHaveBeenCalled();
  });

  it("accepts a concurrent duplicate only after the complete target matches", async () => {
    const test = enqueueFixture();
    test.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "raced-job", targetId: input.targetId }]);
    test.create.mockRejectedValue({ code: "P2002" });
    await expect(enqueueCleanupJob(test.tx, input)).resolves.toBe("raced-job");
  });

  it("rejects a colliding duplicate rather than dropping its cleanup request", async () => {
    const test = enqueueFixture();
    test.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "raced-job", targetId: "different" }]);
    test.create.mockRejectedValue({ code: "P2002" });
    await expect(enqueueCleanupJob(test.tx, input)).rejects.toMatchObject({
      name: "DatabaseOperationError",
    });
  });

  it("propagates unrelated failures and duplicates that cannot be accounted for", async () => {
    const test = enqueueFixture();
    const error = { code: "P2002" };
    test.query.mockResolvedValue([]);
    test.create.mockRejectedValue(error);
    await expect(enqueueCleanupJob(test.tx, input)).rejects.toBe(error);
    test.create.mockRejectedValue({ code: "P1001" });
    await expect(enqueueCleanupJob(test.tx, input)).rejects.toEqual({ code: "P1001" });
  });
});
