import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { ObjectStore } from "@html-share/storage";

import { runNextCleanupJob, type CleanupStorageRepository } from "./cleanup-storage.js";

describe("runNextCleanupJob", () => {
  it("deletes queued project objects and marks the job complete", async () => {
    const repository = new FakeRepository({
      id: "job-1",
      kind: "project",
      objectKeys: ["projects/abc12/a.html"],
    });
    const storage = new FakeStorage();

    await expect(runNextCleanupJob({ repository, storage })).resolves.toBe("completed");
    expect(storage.deleted).toEqual([["projects/abc12/a.html"]]);
    expect(repository.completed).toEqual(["job-1"]);
  });

  it("retries a failed physical deletion without changing project visibility", async () => {
    const repository = new FakeRepository({
      id: "job-1",
      kind: "revision",
      objectKeys: ["projects/abc12/a.html"],
    });
    const storage = new FakeStorage(true);

    await expect(runNextCleanupJob({ repository, storage })).resolves.toBe("retry");
    expect(repository.retried).toEqual(["job-1"]);
    expect(repository.completed).toEqual([]);
  });

  it("completes expired auth-state cleanup without issuing object storage deletes", async () => {
    const repository = new FakeRepository({ id: "job-1", kind: "auth_state", objectKeys: [] });
    const storage = new FakeStorage();

    await expect(runNextCleanupJob({ repository, storage })).resolves.toBe("completed");
    expect(storage.deleted).toEqual([]);
    expect(repository.completed).toEqual(["job-1"]);
  });

  it("splits object deletion into storage-compatible batches", async () => {
    const repository = new FakeRepository({
      id: "job-1",
      kind: "project",
      objectKeys: Array.from({ length: 1_001 }, (_, index) => `projects/abc12/${index}.html`),
    });
    const storage = new FakeStorage();

    await expect(runNextCleanupJob({ repository, storage })).resolves.toBe("completed");
    expect(storage.deleted.map((batch) => batch.length)).toEqual([1_000, 1]);
  });
});

class FakeRepository implements CleanupStorageRepository {
  completed: string[] = [];
  retried: string[] = [];

  constructor(
    private job: {
      id: string;
      kind: "auth_state" | "project" | "revision" | "upload";
      objectKeys: string[];
    } | null,
  ) {}

  async claimNextCleanupJob() {
    const job = this.job;
    this.job = null;
    return job === null ? null : { ...job, attemptCount: 1 };
  }

  async completeCleanupJob(input: { id: string }) {
    this.completed.push(input.id);
  }

  async enqueueDueCleanupJobs() {
    return 0;
  }

  async retryCleanupJob(input: { id: string }) {
    this.retried.push(input.id);
  }
}

class FakeStorage implements ObjectStore {
  deleted: string[][] = [];

  constructor(private readonly fail = false) {}

  async createPresignedUpload() {
    return { headers: {}, url: "https://storage.test" };
  }
  async deleteObjects(keys: readonly string[]) {
    this.deleted.push([...keys]);
    if (this.fail) throw new Error("OBJECT_DELETE_PARTIAL_FAILURE");
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
  async listObjects() {
    return { keys: [] };
  }
}
