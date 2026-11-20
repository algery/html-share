import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ProcessingUpload } from "@html-share/db";

import { finalizeNextUpload } from "./finalize-upload.js";
import { createTask, FakeRepository, FakeStorage } from "./finalize-upload.test-helper.js";

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

  it.each([
    [undefined, "verified"],
    ["missing", "missing"],
    ["size", "mismatch"],
    ["type", "mismatch"],
    ["md5", "mismatch"],
    ["timeout", "unavailable"],
  ] as const)("publishes the Demo when cover verification yields %s", async (failure, check) => {
    const cover = {
      expiresAt: new Date(Date.now() + 60_000),
      homepagePath: "index.html",
      contentMd5: "kAFQmDzST7DWlj99KOF/cg==",
      size: 200,
      storageKey: "square-covers/project/upload.jpg",
    };
    const task = createTask({ cover });
    const repository = new FakeRepository(task);
    const storage = new FakeStorage(task, undefined, failure);
    const outcomes: string[] = [];

    await expect(
      finalizeNextUpload({
        headObjectTimeoutMs: 10,
        onOutcome: ({ coverCheck }) => outcomes.push(coverCheck),
        repository,
        storage,
      }),
    ).resolves.toBe("published");

    expect(storage.headKeys).toContain(cover.storageKey);
    expect(storage.getCalls).toBe(0);
    expect(outcomes).toEqual([check]);
    expect(repository.verifiedCoverKey).toBe(failure === undefined ? cover.storageKey : undefined);
    expect(repository.currentRevisionId).toBe("new-revision");
  });

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
    expect(outcomes).toEqual([
      {
        coverCheck: "omitted",
        projectKey: task.projectKey,
        revisionNumber: task.revisionNumber,
        status: "published",
        traceId: "trace-upload-chain",
      },
    ]);
  });
});
