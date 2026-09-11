import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { UploadError } from "./contracts.js";
import { InMemoryUploadRepository } from "./in-memory-upload-repository.js";
import { digestManifest, mimeForPath } from "./manifest-validator.js";
import { createUploadService } from "./upload-service.js";

const user = { dingtalkUserId: "ding-user", displayName: "Demo user", id: "user-1" };
const requestId = "e8b3ca5f-4b24-4b9e-9c47-c0edc020be55";

describe("UploadService", () => {
  it("creates exact per-file keys and keeps a request idempotent for 24 hours", async () => {
    const now = new Date("2026-09-02T00:00:00.000Z");
    const service = createUploadService({
      now: () => now,
      repository: new InMemoryUploadRepository(),
    });
    const input = validInput();
    const first = await service.prepare(input);
    const second = await service.prepare(input);

    expect(first.projectId).toMatch(/^[a-z0-9]{5}$/);
    expect(first.expiresAt.getTime() - now.getTime()).toBe(5 * 60 * 1000);
    expect(first.files).toEqual([
      expect.objectContaining({
        relativePath: "index.html",
        storageKey: `projects/${first.projectId}/revisions/1/index.html`,
      }),
    ]);
    expect(second).toMatchObject({
      idempotent: true,
      projectId: first.projectId,
      uploadId: first.uploadId,
    });
  });

  it("issues a fresh task for an expired request and keeps its project", async () => {
    let now = new Date("2026-09-02T00:00:00.000Z");
    const service = createUploadService({
      now: () => now,
      repository: new InMemoryUploadRepository(),
    });
    const input = validInput();
    const first = await service.prepare(input);
    now = new Date(first.expiresAt.getTime() + 1);

    const replacement = await service.prepare(input);
    const completion = await service.complete({
      ownerUserId: user.id,
      uploadId: replacement.uploadId,
    });

    expect(replacement).toMatchObject({ idempotent: false, projectId: first.projectId });
    expect(replacement.uploadId).not.toBe(first.uploadId);
    expect(replacement.revisionNumber).toBe(2);
    expect(completion.status).toBe("processing");
  });

  it("rejects invalid paths and missing target files before reserving a task", async () => {
    const service = createUploadService({ repository: new InMemoryUploadRepository() });
    const file = manifestFile("index.html", "x");
    const unsafe = { ...file, relativePath: "../index.html" };
    await expect(
      service.prepare({
        ...validInput(),
        files: [unsafe],
        manifestDigest: digestManifest([unsafe]),
        targetHtml: "../index.html",
      }),
    ).rejects.toMatchObject({ code: "INVALID_UPLOAD_INPUT" } satisfies Partial<UploadError>);
    await expect(
      service.prepare({ ...validInput(), targetHtml: "missing.html" }),
    ).rejects.toMatchObject({ code: "INVALID_UPLOAD_INPUT" } satisfies Partial<UploadError>);
  });
});

function validInput() {
  const files = [manifestFile("index.html", "x")];
  return {
    action: "create" as const,
    clientRequestId: requestId,
    displayName: "Demo",
    files,
    manifestDigest: digestManifest(files),
    owner: user,
    targetHtml: "index.html",
  };
}

function manifestFile(relativePath: string, contents: string) {
  const source = Buffer.from(contents);
  return {
    contentMd5: createHash("md5").update(source).digest("base64"),
    mimeType: mimeForPath(relativePath),
    relativePath,
    sha256: createHash("sha256").update(source).digest("hex"),
    size: source.length,
  };
}
