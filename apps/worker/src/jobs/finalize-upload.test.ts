import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { ProcessingUpload, StoredFile } from "@html-share/db";
import type { ObjectStore } from "@html-share/storage";

import {
  cleanupUploadArtifacts,
  finalizeNextUpload,
  type UploadFinalizerRepository,
} from "./finalize-upload.js";

describe("finalizeNextUpload", () => {
  it("rejects an object whose actual ZIP size differs before downloading it", async () => {
    const repository = new FakeRepository(createTask({ declaredArchiveSize: 10 }));
    const storage = new FakeStorage({ archive: buildZip("index.html", "demo"), headSize: 11 });

    await expect(finalizeNextUpload({ repository, storage })).resolves.toBe("failed");

    expect(storage.getCalls).toBe(0);
    expect(repository.failed).toBe("ARCHIVE_UPLOAD_SIZE_MISMATCH");
    expect(repository.published).toBe(false);
  });

  it("keeps the current revision untouched when manifest verification fails", async () => {
    const archive = buildZip("index.html", "new demo");
    const repository = new FakeRepository(
      createTask({ declaredArchiveSize: archive.length, manifestDigest: "0".repeat(64) }),
    );
    const storage = new FakeStorage({ archive, headSize: archive.length });

    await expect(finalizeNextUpload({ repository, storage })).resolves.toBe("failed");

    expect(repository.published).toBe(false);
    expect(repository.currentRevisionId).toBe("old-revision");
    expect(repository.stagedKeys).toEqual(["projects/abc12/revisions/2/index.html"]);
    expect(repository.failed).toBe("ARCHIVE_MANIFEST_MISMATCH");
  });

  it("publishes only after every object write and manifest verification succeeds", async () => {
    const source = "new demo";
    const archive = buildZip("index.html", source);
    const hash = createHash("sha256").update(source).digest("hex");
    const manifestDigest = createHash("sha256")
      .update(`index.html\u0000${Buffer.byteLength(source)}\u0000${hash}\n`)
      .digest("hex");
    const repository = new FakeRepository(
      createTask({ declaredArchiveSize: archive.length, manifestDigest }),
    );
    const storage = new FakeStorage({ archive, headSize: archive.length });

    await expect(finalizeNextUpload({ repository, storage })).resolves.toBe("published");

    expect(repository.published).toBe(true);
    expect(repository.currentRevisionId).toBe("new-revision");
    expect(repository.stagedKeys).toEqual(["projects/abc12/revisions/2/index.html"]);
  });

  it("retains the active revision when temporary ZIP cleanup fails after publication", async () => {
    const source = "new demo";
    const archive = buildZip("index.html", source);
    const repository = new FakeRepository(
      createTask({ declaredArchiveSize: archive.length, manifestDigest: manifestFor(source) }),
    );
    const storage = new FakeStorage({ archive, failDelete: true, headSize: archive.length });

    await expect(finalizeNextUpload({ repository, storage })).resolves.toBe("published");

    expect(repository.currentRevisionId).toBe("new-revision");
    expect(repository.failed).toBeNull();
  });

  it("rejects a missing target HTML without switching the current revision", async () => {
    const source = "new demo";
    const archive = buildZip("index.html", source);
    const repository = new FakeRepository(
      createTask({
        declaredArchiveSize: archive.length,
        manifestDigest: manifestFor(source),
        targetHtml: "missing.html",
      }),
    );
    const storage = new FakeStorage({ archive, headSize: archive.length });

    await expect(finalizeNextUpload({ repository, storage })).resolves.toBe("failed");

    expect(repository.currentRevisionId).toBe("old-revision");
    expect(repository.failed).toBe("TARGET_HTML_MISSING");
  });

  it("reports failure when the database did not atomically activate the revision", async () => {
    const source = "new demo";
    const archive = buildZip("index.html", source);
    const repository = new FakeRepository(
      createTask({ declaredArchiveSize: archive.length, manifestDigest: manifestFor(source) }),
      false,
    );
    const storage = new FakeStorage({ archive, headSize: archive.length });

    await expect(finalizeNextUpload({ repository, storage })).resolves.toBe("failed");

    expect(repository.currentRevisionId).toBe("old-revision");
    expect(repository.failed).toBe("PUBLISH_NOT_APPLIED");
  });

  it("deletes cleanup objects in S3-compatible batches before marking tasks cleaned", async () => {
    const keys = Array.from({ length: 1001 }, (_, index) => `temporary/uploads/${index}.zip`);
    const repository = new FakeRepository(null, true, keys);
    const storage = new FakeStorage({ archive: Buffer.alloc(0), headSize: 0 });

    await expect(cleanupUploadArtifacts({ repository, storage })).resolves.toBe(1001);

    expect(storage.deletedBatches.map((batch) => batch.length)).toEqual([1000, 1]);
    expect(repository.cleanedObjectKeys).toEqual(keys);
  });

  it("does not mark cleanup complete when any object-store batch fails", async () => {
    const repository = new FakeRepository(null, true, ["temporary/uploads/failed.zip"]);
    const storage = new FakeStorage({ archive: Buffer.alloc(0), failDelete: true, headSize: 0 });

    await expect(cleanupUploadArtifacts({ repository, storage })).rejects.toThrow("delete failed");

    expect(repository.cleanedObjectKeys).toEqual([]);
  });
});

class FakeRepository implements UploadFinalizerRepository {
  currentRevisionId = "old-revision";
  failed: string | null = null;
  published = false;
  stagedKeys: string[] = [];
  cleanedObjectKeys: string[] = [];

  constructor(
    private task: ProcessingUpload | null,
    private readonly publishResult = true,
    private readonly cleanupKeys: string[] = [],
  ) {}

  async claimNextProcessingUpload() {
    const claimed = this.task;
    this.task = null;
    return claimed;
  }

  async failUpload(input: { failureCode: string }) {
    this.failed = input.failureCode;
  }

  async listCleanupObjectKeys() {
    return this.cleanupKeys;
  }

  async publishUpload(input: {
    uploadId: string;
    files: readonly StoredFile[];
    totalSize: number;
    now: Date;
  }) {
    expect(input.files).toHaveLength(1);
    if (!this.publishResult) return false;
    this.published = true;
    this.currentRevisionId = "new-revision";
    return true;
  }

  async recordStagedObjectKey(input: { storageKey: string }) {
    this.stagedKeys.push(input.storageKey);
  }

  async markTemporaryObjectsCleaned(input: { objectKeys: readonly string[] }) {
    this.cleanedObjectKeys.push(...input.objectKeys);
    return undefined;
  }
}

class FakeStorage implements ObjectStore {
  getCalls = 0;
  deletedBatches: string[][] = [];
  private readonly written = new Map<string, Buffer>();

  constructor(
    private readonly input: { archive: Buffer; headSize: number; failDelete?: boolean },
  ) {}

  async createPresignedZipUpload() {
    return { headers: {}, url: "https://storage.test/upload" };
  }

  async deleteObjects(keys: readonly string[]) {
    this.deletedBatches.push([...keys]);
    if (this.input.failDelete) throw new Error("delete failed");
    return undefined;
  }

  async ensurePrivateBucket() {
    return undefined;
  }

  async getObject() {
    this.getCalls += 1;
    return Readable.from([this.input.archive]);
  }

  async headObject() {
    return { size: this.input.headSize };
  }

  async putObject(input: { body: Readable; key: string }) {
    const chunks: Buffer[] = [];
    for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
    this.written.set(input.key, Buffer.concat(chunks));
  }
}

function manifestFor(source: string) {
  const hash = createHash("sha256").update(source).digest("hex");
  return createHash("sha256")
    .update(`index.html\u0000${Buffer.byteLength(source)}\u0000${hash}\n`)
    .digest("hex");
}

function createTask(overrides: Partial<ProcessingUpload>): ProcessingUpload {
  return {
    action: "replace",
    declaredArchiveSize: 1,
    declaredFileCount: 1,
    declaredTotalSize: 8,
    manifestDigest: "a".repeat(64),
    ownerUserId: "owner",
    projectId: "project",
    projectKey: "abc12",
    revisionId: "revision",
    revisionNumber: 2,
    temporaryObjectKey: "temporary/uploads/task.zip",
    targetHtml: "index.html",
    tenantId: "tenant",
    uploadId: "upload",
    ...overrides,
  };
}

function buildZip(name: string, contents: string) {
  const filename = Buffer.from(name);
  const source = Buffer.from(contents);
  const crc = crc32(source);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(source.length, 18);
  local.writeUInt32LE(source.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(source.length, 20);
  central.writeUInt32LE(source.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE(0o100644 * 0x1_0000, 38);
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(1, 8);
  footer.writeUInt16LE(1, 10);
  footer.writeUInt32LE(central.length + filename.length, 12);
  footer.writeUInt32LE(local.length + filename.length + source.length, 16);
  return Buffer.concat([local, filename, source, central, filename, footer]);
}

function crc32(buffer: Buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
