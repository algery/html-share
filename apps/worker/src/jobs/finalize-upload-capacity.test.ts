import { Readable } from "node:stream";

import { digestManifest } from "@html-share/core";
import type { ProcessingUpload } from "@html-share/db";
import type { ObjectStore } from "@html-share/storage";
import { describe, expect, it } from "vitest";

import { finalizeNextUpload, type UploadFinalizerRepository } from "./finalize-upload.js";

describe("finalizeNextUpload metadata capacity", () => {
  it("verifies 500 delayed metadata objects within five seconds using bounded concurrency", async () => {
    const task = createFiveHundredFileTask();
    const repository = new CapacityRepository(task);
    const storage = new DelayedHeadStorage(task, 10);
    const startedAt = performance.now();

    await expect(finalizeNextUpload({ repository, storage })).resolves.toBe("published");

    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(storage.headCalls).toBe(500);
    expect(storage.maxActiveHeads).toBeGreaterThan(1);
    expect(storage.maxActiveHeads).toBeLessThanOrEqual(20);
    expect(storage.getCalls).toBe(0);
  });
});

class CapacityRepository implements UploadFinalizerRepository {
  constructor(private task: ProcessingUpload | null) {}

  async claimNextProcessingUpload() {
    const task = this.task;
    this.task = null;
    return task;
  }

  async failUpload() {
    return true;
  }

  async markUploadFilesVerified() {
    return undefined;
  }

  async publishUpload() {
    return true;
  }
}

class DelayedHeadStorage implements ObjectStore {
  activeHeads = 0;
  getCalls = 0;
  headCalls = 0;
  maxActiveHeads = 0;

  constructor(
    private readonly task: ProcessingUpload,
    private readonly delayMs: number,
  ) {}

  async createPresignedUpload() {
    return { headers: {}, url: "https://storage.test" };
  }

  async deleteObjects() {
    return undefined;
  }

  async ensurePrivateBucket() {
    return undefined;
  }

  async getObject() {
    this.getCalls += 1;
    return Readable.from([]);
  }

  async headObject(key: string) {
    this.headCalls += 1;
    this.activeHeads += 1;
    this.maxActiveHeads = Math.max(this.maxActiveHeads, this.activeHeads);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.activeHeads -= 1;
    const file = this.task.files.find((candidate) => candidate.storageKey === key);
    return file === undefined
      ? null
      : { contentMd5: file.contentMd5, contentType: file.mimeType, size: file.size };
  }

  async listObjects() {
    return { keys: [] };
  }
}

function createFiveHundredFileTask(): ProcessingUpload {
  const files = Array.from({ length: 500 }, (_, index) => ({
    contentHash: "a".repeat(64),
    contentMd5: "ndTkYSaMgDT1yFZOFVxnpg==",
    id: `file-${index}`,
    mimeType: index === 0 ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
    path: index === 0 ? "index.html" : `assets/${index}.txt`,
    size: 1,
    storageKey: `projects/project-uuid/revisions/revision-uuid/${index}`,
  }));
  return {
    action: "create",
    declaredFileCount: files.length,
    declaredTotalSize: files.length,
    files,
    manifestDigest: digestManifest(
      files.map((file) => ({
        contentMd5: file.contentMd5,
        mimeType: file.mimeType,
        relativePath: file.path,
        sha256: file.contentHash,
        size: file.size,
      })),
    ),
    ownerUserId: "owner",
    projectId: "project-uuid",
    projectKey: "abc12",
    revisionId: "revision-uuid",
    revisionNumber: 1,
    targetHtml: "index.html",
    tenantId: "tenant",
    uploadId: "upload",
  };
}
