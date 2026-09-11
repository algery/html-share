import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { digestManifest } from "@html-share/core";
import type { ProcessingUpload } from "@html-share/db";
import type { ObjectStore } from "@html-share/storage";

import { finalizeNextUpload, type UploadFinalizerRepository } from "./finalize-upload.js";

describe("finalizeNextUpload", () => {
  it("has no body-read, archive, extraction, or local temporary-file code path", async () => {
    const source = await readFile(new URL("./finalize-upload.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\.getObject\(|\.putObject\(|node:fs|node:os|yauzl|unzip|mkdtemp/);
  });

  it("creates no runtime temporary files on success, failure, or asynchronous timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "html-share-finalizer-no-temp-"));
    const previousTmpdir = process.env["TMPDIR"];
    process.env["TMPDIR"] = directory;
    try {
      for (const failure of [undefined, "missing", "timeout"] as const) {
        const task = createTask();
        await finalizeNextUpload({
          headObjectTimeoutMs: 10,
          repository: new FakeRepository(task),
          storage: new FakeStorage(task, failure),
        });
      }
      expect(await readdir(directory)).toEqual([]);
    } finally {
      if (previousTmpdir === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previousTmpdir;
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("publishes only after every exact object passes HeadObject verification", async () => {
    const task = createTask();
    const repository = new FakeRepository(task);
    const storage = new FakeStorage(task);

    await expect(finalizeNextUpload({ repository, storage })).resolves.toBe("published");

    expect(storage.headKeys).toEqual(task.files.map((file) => file.storageKey));
    expect(storage.getCalls).toBe(0);
    expect(repository.verified).toBe(true);
    expect(repository.published).toBe(true);
    expect(repository.currentRevisionId).toBe("new-revision");
  });

  it.each([
    ["missing", "UPLOAD_OBJECT_MISSING"],
    ["size", "UPLOAD_OBJECT_SIZE_MISMATCH"],
    ["type", "UPLOAD_OBJECT_CONTENT_TYPE_MISMATCH"],
    ["md5", "UPLOAD_OBJECT_CONTENT_MD5_MISMATCH"],
    ["timeout", "UPLOAD_OBJECT_HEAD_TIMEOUT"],
  ] as const)(
    "fails on %s without reading a body or exposing a partial revision",
    async (failure, code) => {
      const task = createTask();
      const repository = new FakeRepository(task);
      const storage = new FakeStorage(task, failure);

      await expect(
        finalizeNextUpload({ headObjectTimeoutMs: 10, repository, storage }),
      ).resolves.toBe("failed");

      expect(storage.getCalls).toBe(0);
      expect(storage.deletedBatches).toEqual([]);
      expect(repository.failed).toBe(code);
      expect(repository.published).toBe(false);
      expect(repository.currentRevisionId).toBe("old-revision");
    },
  );

  it("rejects declaration, target, and manifest drift before any object call", async () => {
    const base = createTask();
    const cases: [ProcessingUpload, string][] = [
      [{ ...base, declaredFileCount: 3 }, "UPLOAD_DECLARATION_MISMATCH"],
      [{ ...base, targetHtml: "missing.html" }, "TARGET_HTML_MISSING"],
      [{ ...base, manifestDigest: "0".repeat(64) }, "UPLOAD_MANIFEST_MISMATCH"],
    ];
    for (const [task, code] of cases) {
      const repository = new FakeRepository(task);
      const storage = new FakeStorage(task);
      await expect(finalizeNextUpload({ repository, storage })).resolves.toBe("failed");
      expect(storage.getCalls).toBe(0);
      expect(storage.headKeys).toEqual([]);
      expect(repository.failed).toBe(code);
      expect(repository.currentRevisionId).toBe("old-revision");
    }
  });

  it("keeps the old revision when the atomic publish precondition fails", async () => {
    const task = createTask();
    const repository = new FakeRepository(task, false);
    const storage = new FakeStorage(task);

    await expect(finalizeNextUpload({ repository, storage })).resolves.toBe("failed");

    expect(storage.getCalls).toBe(0);
    expect(repository.failed).toBe("PUBLISH_NOT_APPLIED");
    expect(repository.currentRevisionId).toBe("old-revision");
  });

  it("leaves all failed-task deletion to the post-expiry cleanup owner", async () => {
    const task = createTask();
    const repository = new FakeRepository(task);
    const storage = new FakeStorage(task, "missing");

    await finalizeNextUpload({ repository, storage });

    expect(storage.deletedBatches).toEqual([]);
  });

  it("reports the persisted trace for both final outcomes", async () => {
    const task = createTask({ traceId: "trace-upload-chain" });
    const outcomes: { status: "published" | "failed"; traceId?: string }[] = [];
    await finalizeNextUpload({
      onOutcome: (outcome) => outcomes.push(outcome),
      repository: new FakeRepository(task),
      storage: new FakeStorage(task),
    });
    expect(outcomes).toEqual([{ status: "published", traceId: "trace-upload-chain" }]);
  });
});

class FakeRepository implements UploadFinalizerRepository {
  currentRevisionId = "old-revision";
  failed: string | null = null;
  published = false;
  verified = false;

  constructor(
    private task: ProcessingUpload | null,
    private readonly publishResult = true,
  ) {}

  async claimNextProcessingUpload() {
    const claimed = this.task;
    this.task = null;
    return claimed;
  }

  async failUpload(input: { failureCode: string }) {
    this.failed = input.failureCode;
    return true;
  }

  async markUploadFilesVerified() {
    this.verified = true;
  }

  async publishUpload() {
    if (!this.publishResult) return false;
    this.published = true;
    this.currentRevisionId = "new-revision";
    return true;
  }
}

type Failure = "md5" | "missing" | "size" | "timeout" | "type";

class FakeStorage implements ObjectStore {
  getCalls = 0;
  headKeys: string[] = [];
  deletedBatches: string[][] = [];

  constructor(
    private readonly task: ProcessingUpload | null,
    private readonly failure?: Failure,
  ) {}

  async createPresignedUpload() {
    return { headers: {}, url: "https://storage.test/upload" };
  }

  async deleteObjects(keys: readonly string[]) {
    this.deletedBatches.push([...keys]);
  }

  async ensurePrivateBucket() {
    return undefined;
  }

  async getObject() {
    this.getCalls += 1;
    return Readable.from([]);
  }

  async headObject(key: string, options?: { abortSignal?: AbortSignal }) {
    this.headKeys.push(key);
    if (this.failure === "timeout") {
      await new Promise<never>((_resolve, reject) => {
        options?.abortSignal?.addEventListener(
          "abort",
          () => reject(new Error("head request aborted")),
          { once: true },
        );
      });
    }
    if (this.failure === "missing") return null;
    const file = this.task?.files.find((candidate) => candidate.storageKey === key);
    if (file === undefined) return null;
    return {
      contentMd5: this.failure === "md5" ? "AAAAAAAAAAAAAAAAAAAAAA==" : file.contentMd5,
      contentType: this.failure === "type" ? "text/plain" : file.mimeType,
      size: this.failure === "size" ? file.size + 1 : file.size,
    };
  }

  async listObjects() {
    return { keys: [] };
  }
}

function createTask(overrides: Partial<ProcessingUpload> = {}): ProcessingUpload {
  const files = [file("index.html", "new demo"), file("style.css", "body{}")];
  return {
    action: "replace",
    declaredFileCount: files.length,
    declaredTotalSize: files.reduce((sum, current) => sum + current.size, 0),
    files,
    manifestDigest: digestManifest(
      files.map((current) => ({
        contentMd5: current.contentMd5,
        mimeType: current.mimeType,
        relativePath: current.path,
        sha256: current.contentHash,
        size: current.size,
      })),
    ),
    ownerUserId: "owner",
    projectId: "project",
    projectKey: "abc12",
    revisionId: "revision",
    revisionNumber: 2,
    targetHtml: "index.html",
    tenantId: "tenant",
    uploadId: "upload",
    ...overrides,
  };
}

function file(path: string, contents: string) {
  const source = Buffer.from(contents);
  const mimeType = path.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8";
  return {
    contentHash: createHash("sha256").update(source).digest("hex"),
    contentMd5: createHash("md5").update(source).digest("base64"),
    id: `file-${path}`,
    mimeType,
    path,
    size: source.length,
    storageKey: `projects/abc12/revisions/2/${path}`,
  };
}
