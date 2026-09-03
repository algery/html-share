import { describe, expect, it } from "vitest";

import { InMemoryUploadRepository } from "./in-memory-upload-repository.js";
import { UploadError } from "./contracts.js";
import { createUploadService } from "./upload-service.js";

const user = { dingtalkUserId: "ding-user", displayName: "Demo user", id: "user-1" };
const digest = "a".repeat(64);
const requestId = "e8b3ca5f-4b24-4b9e-9c47-c0edc020be55";

describe("UploadService", () => {
  it("creates a five-character project task and keeps a 24-hour request idempotent", async () => {
    const now = new Date("2026-09-02T00:00:00.000Z");
    const service = createUploadService({
      now: () => now,
      repository: new InMemoryUploadRepository(),
    });
    const input = {
      action: "create" as const,
      archiveSize: 1,
      clientRequestId: requestId,
      displayName: "Demo",
      fileCount: 1,
      manifestDigest: digest,
      targetHtml: "index.html",
      totalSize: 1,
      owner: user,
    };
    const first = await service.prepare(input);
    const second = await service.prepare(input);
    expect(first.projectId).toMatch(/^[a-z0-9]{5}$/);
    expect(first.expiresAt.getTime() - now.getTime()).toBe(5 * 60 * 1000);
    expect(second).toMatchObject({
      idempotent: true,
      projectId: first.projectId,
      uploadId: first.uploadId,
    });
  });

  it("issues a fresh task for an expired idempotency key and keeps its project", async () => {
    let now = new Date("2026-09-02T00:00:00.000Z");
    const service = createUploadService({
      now: () => now,
      repository: new InMemoryUploadRepository(),
    });
    const input = {
      action: "create" as const,
      archiveSize: 1,
      clientRequestId: requestId,
      displayName: "Demo",
      fileCount: 1,
      manifestDigest: digest,
      targetHtml: "index.html",
      totalSize: 1,
      owner: user,
    };
    const first = await service.prepare(input);
    now = new Date(first.expiresAt.getTime() + 1);

    const replacement = await service.prepare(input);
    const completion = await service.complete({
      ownerUserId: user.id,
      uploadId: replacement.uploadId,
    });

    expect(replacement).toMatchObject({ idempotent: false, projectId: first.projectId });
    expect(replacement.uploadId).not.toBe(first.uploadId);
    expect(replacement.expiresAt.getTime() - now.getTime()).toBe(5 * 60 * 1000);
    expect(completion.status).toBe("processing");
  });

  it("accepts ZIP metadata beyond 20 MiB when extracted files are exactly 20 MiB", async () => {
    const service = createUploadService({ repository: new InMemoryUploadRepository() });

    await expect(
      service.prepare({
        action: "create",
        archiveSize: 20 * 1024 * 1024 + 4096,
        clientRequestId: "ff3e95a1-29e6-4703-9a1b-fc9876f4961c",
        displayName: "Boundary demo",
        fileCount: 4,
        manifestDigest: digest,
        owner: user,
        targetHtml: "index.html",
        totalSize: 20 * 1024 * 1024,
      }),
    ).resolves.toMatchObject({ status: "prepared" });
  });

  it("rejects invalid paths and manifest digests before reserving a task", async () => {
    const service = createUploadService({ repository: new InMemoryUploadRepository() });
    await expect(
      service.prepare({
        action: "create",
        archiveSize: 1,
        clientRequestId: requestId,
        displayName: "Demo",
        fileCount: 1,
        manifestDigest: "invalid",
        owner: user,
        targetHtml: "../index.html",
        totalSize: 1,
      }),
    ).rejects.toMatchObject({ code: "INVALID_UPLOAD_INPUT" } satisfies Partial<UploadError>);
    await expect(
      service.prepare({
        action: "create",
        archiveSize: 1,
        clientRequestId: requestId,
        displayName: "Demo",
        fileCount: 1,
        manifestDigest: digest,
        owner: user,
        targetHtml: "style.css",
        totalSize: 1,
      }),
    ).rejects.toMatchObject({ code: "INVALID_UPLOAD_INPUT" } satisfies Partial<UploadError>);
  });
});
