import { Readable } from "node:stream";

import type { ClaimedObjectSweep } from "@html-share/db";
import type { ObjectStore } from "@html-share/storage";
import { describe, expect, it } from "vitest";

import {
  runNextOrphanObjectSweep,
  type OrphanObjectSweepRepository,
} from "./sweep-orphan-objects.js";

describe("runNextOrphanObjectSweep", () => {
  it("deletes only unreferenced keys and advances the shared cursor", async () => {
    const claimedAt = new Date("2026-09-06T00:00:00.000Z");
    const repository = new FakeRepository(
      { claimedAt, continuationToken: "cursor-1" },
      new Set(["projects/abc12/revisions/1/index.html"]),
    );
    const storage = new FakeStorage({
      keys: ["projects/abc12/revisions/1/index.html", "projects/abc12/revisions/2/orphan.html"],
      nextContinuationToken: "cursor-2",
    });

    await expect(
      runNextOrphanObjectSweep({ repository, storage, now: () => claimedAt }),
    ).resolves.toBe("completed");

    expect(storage.listInputs).toEqual([
      expect.objectContaining({
        continuationToken: "cursor-1",
        maxKeys: 1_000,
        prefix: "projects/",
      }),
    ]);
    expect(storage.deleted).toEqual([["projects/abc12/revisions/2/orphan.html"]]);
    expect(repository.completed).toEqual([
      { claimedAt, nextContinuationToken: "cursor-2", now: claimedAt },
    ]);
    expect(repository.retried).toEqual([]);
  });

  it("actively aborts a stalled listing and schedules a retry", async () => {
    const claimedAt = new Date("2026-09-06T00:00:00.000Z");
    const repository = new FakeRepository({ claimedAt }, new Set());
    const storage = new FakeStorage({ keys: [] }, true);
    const startedAt = performance.now();

    await expect(
      runNextOrphanObjectSweep({
        listTimeoutMs: 10,
        now: () => claimedAt,
        repository,
        storage,
      }),
    ).resolves.toBe("retry");

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(storage.aborted).toBe(true);
    expect(repository.retried).toEqual([{ claimedAt, now: claimedAt }]);
    expect(repository.completed).toEqual([]);
  });
});

class FakeRepository implements OrphanObjectSweepRepository {
  completed: Parameters<OrphanObjectSweepRepository["completeObjectSweep"]>[0][] = [];
  retried: Parameters<OrphanObjectSweepRepository["retryObjectSweep"]>[0][] = [];

  constructor(
    private sweep: ClaimedObjectSweep | null,
    private readonly referenced: Set<string>,
  ) {}

  async claimObjectSweep() {
    const sweep = this.sweep;
    this.sweep = null;
    return sweep;
  }

  async completeObjectSweep(input: (typeof this.completed)[number]) {
    this.completed.push(input);
  }

  async referencedObjectKeys() {
    return this.referenced;
  }

  async retryObjectSweep(input: (typeof this.retried)[number]) {
    this.retried.push(input);
  }
}

class FakeStorage implements ObjectStore {
  aborted = false;
  deleted: string[][] = [];
  listInputs: Parameters<ObjectStore["listObjects"]>[0][] = [];

  constructor(
    private readonly page: Awaited<ReturnType<ObjectStore["listObjects"]>>,
    private readonly stall = false,
  ) {}

  async createPresignedUpload() {
    return { headers: {}, url: "https://storage.test" };
  }

  async deleteObjects(keys: readonly string[]) {
    this.deleted.push([...keys]);
  }

  async ensurePrivateBucket() {
    return undefined;
  }

  async getObject() {
    return Readable.from([]);
  }

  async headObject() {
    return null;
  }

  async listObjects(input: Parameters<ObjectStore["listObjects"]>[0]) {
    this.listInputs.push(input);
    if (!this.stall) return this.page;
    return await new Promise<never>((_resolve, reject) => {
      input.abortSignal?.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          reject(new Error("list aborted"));
        },
        { once: true },
      );
    });
  }
}
