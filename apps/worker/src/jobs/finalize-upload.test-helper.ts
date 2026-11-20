import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { digestManifest } from "@html-share/core";
import type { ProcessingUpload } from "@html-share/db";
import type { ObjectStore } from "@html-share/storage";

import type { UploadFinalizerRepository } from "./finalize-upload.js";

export class FakeRepository implements UploadFinalizerRepository {
  currentRevisionId = "old-revision";
  failed: string | null = null;
  published = false;
  verified = false;
  verifiedCoverKey: string | undefined;

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

  async publishUpload(input: { verifiedCoverKey?: string }) {
    this.verifiedCoverKey = input.verifiedCoverKey;
    if (!this.publishResult) return false;
    this.published = true;
    this.currentRevisionId = "new-revision";
    return true;
  }
}

type Failure = "md5" | "missing" | "size" | "timeout" | "type";

export class FakeStorage implements ObjectStore {
  getCalls = 0;
  headKeys: string[] = [];
  deletedBatches: string[][] = [];

  constructor(
    private readonly task: ProcessingUpload | null,
    private readonly failure?: Failure,
    private readonly coverFailure?: Failure,
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
    const cover = this.task?.cover;
    const isCover = cover?.storageKey === key;
    const failure = isCover ? this.coverFailure : this.failure;
    if (failure === "timeout") {
      await new Promise<never>((_resolve, reject) => {
        options?.abortSignal?.addEventListener(
          "abort",
          () => reject(new Error("head request aborted")),
          { once: true },
        );
      });
    }
    if (failure === "missing") return null;
    const file = isCover
      ? { ...cover, mimeType: "image/jpeg" }
      : this.task?.files.find((candidate) => candidate.storageKey === key);
    if (file === undefined) return null;
    return {
      contentMd5: failure === "md5" ? "AAAAAAAAAAAAAAAAAAAAAA==" : file.contentMd5,
      contentType: failure === "type" ? "text/plain" : file.mimeType,
      size: failure === "size" ? file.size + 1 : file.size,
    };
  }

  async listObjects() {
    return { keys: [] };
  }
}

export function createTask(overrides: Partial<ProcessingUpload> = {}): ProcessingUpload {
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
