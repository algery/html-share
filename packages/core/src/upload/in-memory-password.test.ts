import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createPasswordCrypto } from "../access/password-crypto.js";
import { UPLOAD_IDEMPOTENCY_TTL_MS, type ValidatedPrepareDemoUploadInput } from "./contracts.js";
import { InMemoryUploadRepository } from "./in-memory-upload-repository.js";

const now = new Date("2026-09-09T10:00:00Z");
const owner = { id: "owner", dingtalkUserId: "ding-owner", displayName: "Owner" };
function setup() {
  const crypto = createPasswordCrypto(randomBytes(32).toString("base64"));
  return { crypto, repository: new InMemoryUploadRepository({ passwordCrypto: crypto }) };
}
function input(overrides: Partial<ValidatedPrepareDemoUploadInput> = {}) {
  return {
    action: "create" as const,
    clientRequestId: randomUUID(),
    displayName: "Demo",
    files: [
      {
        relativePath: "nested/index.html",
        mimeType: "text/html",
        size: 1,
        sha256: "a".repeat(64),
        contentMd5: "hash",
      },
    ],
    fileCount: 1,
    totalSize: 1,
    manifestDigest: "a".repeat(64),
    targetHtml: "nested/index.html",
    owner,
    now,
    ...overrides,
  };
}
function statusInput(uploadId: string, clock = now) {
  return { uploadId, ownerUserId: owner.id, now: clock };
}
async function publish(repository: InMemoryUploadRepository, uploadId: string) {
  await repository.requestCompletion(statusInput(uploadId));
  expect(await repository.publishUpload({ uploadId, now })).toBe(true);
  return repository.getStatus(statusInput(uploadId));
}

describe("in-memory password publication", () => {
  it("preserves organization default and rejects password generation without configured crypto", async () => {
    const repository = new InMemoryUploadRepository();
    const prepared = await repository.prepare(input());
    expect(await publish(repository, prepared.uploadId)).toMatchObject({
      accessMode: "organization",
      targetHtml: "nested/index.html",
    });
    expect(await repository.getStatus(statusInput(prepared.uploadId))).not.toHaveProperty(
      "accessPassword",
    );
    await expect(repository.prepare(input({ accessMode: "password" }))).rejects.toMatchObject({
      code: "INVALID_UPLOAD_INPUT",
    });
    await expect(
      repository.prepare(
        input({ action: "replace", projectId: prepared.projectId, regeneratePassword: true }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_UPLOAD_INPUT" });
  });

  it("returns a single generated password only after publication, with authenticated result binding", async () => {
    const { crypto, repository } = setup();
    const generate = vi.spyOn(crypto, "generate");
    const encrypt = vi.spyOn(crypto, "encrypt");
    const decrypt = vi.spyOn(crypto, "decrypt");
    const request = input({ accessMode: "password" });
    const [first, retry] = await Promise.all([
      repository.prepare(request),
      repository.prepare(request),
    ]);
    expect(retry).toMatchObject({ uploadId: first.uploadId, idempotent: true });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await repository.getStatus(statusInput(first.uploadId))).not.toHaveProperty(
      "accessPassword",
    );
    expect(await repository.requestCompletion(statusInput(first.uploadId))).not.toHaveProperty(
      "accessPassword",
    );
    const result = await publish(repository, first.uploadId);
    expect(result).toMatchObject({
      accessMode: "password",
      passwordStatus: "generated",
      targetHtml: "nested/index.html",
    });
    expect(result.accessPassword).toMatch(/^[A-HJ-NP-Za-kmnp-z2-9]{8}$/);
    expect(encrypt).toHaveBeenCalledWith(
      result.accessPassword,
      JSON.stringify([first.uploadId, owner.id, first.projectId, 1]),
    );
    expect(decrypt.mock.calls[0]?.[0]).not.toContain(result.accessPassword);
    expect((await repository.requestCompletion(statusInput(first.uploadId))).accessPassword).toBe(
      result.accessPassword,
    );
    await expect(
      repository.getStatus({ ...statusInput(first.uploadId), ownerUserId: "other" }),
    ).rejects.toMatchObject({ code: "UPLOAD_NOT_FOUND" });
    await expect(
      repository.requestCompletion({ ...statusInput(first.uploadId), ownerUserId: "other" }),
    ).rejects.toMatchObject({ code: "UPLOAD_NOT_FOUND" });
  });

  it("rejects changed idempotency parameters, including after failure or expiry", async () => {
    const { repository } = setup();
    const request = input({ accessMode: "password" });
    const first = await repository.prepare(request);
    for (const patch of [
      { accessMode: "organization" as const },
      { regeneratePassword: true },
      { targetHtml: "other.html" },
    ]) {
      await expect(repository.prepare({ ...request, ...patch })).rejects.toMatchObject({
        code: "INVALID_UPLOAD_INPUT",
      });
    }
    const omitted = { ...request };
    delete omitted.accessMode;
    await expect(repository.prepare(omitted)).rejects.toMatchObject({
      code: "INVALID_UPLOAD_INPUT",
    });
    await repository.failUpload({ uploadId: first.uploadId, now });
    await expect(
      repository.prepare({ ...request, accessMode: "organization" }),
    ).rejects.toMatchObject({ code: "INVALID_UPLOAD_INPUT" });
    const retry = await repository.prepare(request);
    expect(retry.projectId).toBe(first.projectId);
    expect(retry.uploadId).not.toBe(first.uploadId);
    const expiredNow = new Date(retry.expiresAt);
    await expect(
      repository.prepare({ ...request, accessMode: "organization", now: expiredNow }),
    ).rejects.toMatchObject({ code: "INVALID_UPLOAD_INPUT" });
    expect(await repository.getStatus(statusInput(retry.uploadId, expiredNow))).toMatchObject({
      status: "expired",
    });
  });

  it("inherits or explicitly retains passwords and switches only when publication succeeds", async () => {
    const { crypto, repository } = setup();
    const generate = vi.spyOn(crypto, "generate");
    const created = await repository.prepare(input({ accessMode: "password" }));
    const original = await publish(repository, created.uploadId);
    for (const accessMode of [undefined, "password"] as const) {
      const replacement = await repository.prepare(
        input({
          action: "replace",
          projectId: created.projectId,
          ...(accessMode ? { accessMode } : {}),
        }),
      );
      const result = await publish(repository, replacement.uploadId);
      expect(result).toMatchObject({ accessMode: "password", passwordStatus: "retained" });
      expect(result).not.toHaveProperty("accessPassword");
      expect((await repository.getStatus(statusInput(created.uploadId))).accessPassword).toBe(
        original.accessPassword,
      );
    }
    expect(generate).toHaveBeenCalledTimes(1);
    const failed = await repository.prepare(
      input({ action: "replace", projectId: created.projectId, regeneratePassword: true }),
    );
    await repository.requestCompletion(statusInput(failed.uploadId));
    expect((await repository.getStatus(statusInput(created.uploadId))).accessPassword).toBe(
      original.accessPassword,
    );
    await repository.failUpload({ uploadId: failed.uploadId, now });
    expect(await repository.getStatus(statusInput(failed.uploadId))).not.toHaveProperty(
      "accessPassword",
    );
    expect((await repository.getStatus(statusInput(created.uploadId))).accessPassword).toBe(
      original.accessPassword,
    );
    const reset = await repository.prepare(
      input({ action: "replace", projectId: created.projectId, regeneratePassword: true }),
    );
    const resetResult = await publish(repository, reset.uploadId);
    expect(resetResult.accessPassword).not.toBe(original.accessPassword);
    expect(await repository.getStatus(statusInput(created.uploadId))).toMatchObject({
      passwordStatus: "unavailable",
    });
    const disable = await repository.prepare(
      input({ action: "replace", projectId: created.projectId, accessMode: "organization" }),
    );
    expect((await repository.getStatus(statusInput(reset.uploadId))).accessPassword).toBe(
      resetResult.accessPassword,
    );
    expect(await publish(repository, disable.uploadId)).toMatchObject({
      accessMode: "organization",
    });
    expect(await repository.getStatus(statusInput(reset.uploadId))).not.toHaveProperty(
      "accessPassword",
    );
    const enable = await repository.prepare(
      input({ action: "replace", projectId: created.projectId, accessMode: "password" }),
    );
    expect(await publish(repository, enable.uploadId)).toMatchObject({
      passwordStatus: "generated",
    });
  });

  it("enforces exact 24-hour creation boundary and deletion invalidation", async () => {
    const { repository } = setup();
    const created = await repository.prepare(input({ accessMode: "password" }));
    await publish(repository, created.uploadId);
    const boundary = new Date(now.getTime() + UPLOAD_IDEMPOTENCY_TTL_MS);
    expect(
      await repository.getStatus(statusInput(created.uploadId, new Date(boundary.getTime() - 1))),
    ).toHaveProperty("accessPassword");
    expect(await repository.getStatus(statusInput(created.uploadId, boundary))).toMatchObject({
      passwordStatus: "unavailable",
    });
    expect(await repository.getStatus(statusInput(created.uploadId, boundary))).not.toHaveProperty(
      "accessPassword",
    );
    const another = await repository.prepare(input({ accessMode: "password" }));
    await publish(repository, another.uploadId);
    await expect(
      repository.deleteProject({ projectId: another.projectId, ownerUserId: "other" }),
    ).rejects.toMatchObject({ code: "PROJECT_FORBIDDEN" });
    await repository.deleteProject({ projectId: another.projectId, ownerUserId: owner.id });
    expect(await repository.getStatus(statusInput(another.uploadId))).toMatchObject({
      passwordStatus: "unavailable",
    });
    expect(await repository.getStatus(statusInput(another.uploadId))).not.toHaveProperty(
      "accessPassword",
    );
    await expect(
      repository.prepare(input({ action: "replace", projectId: another.projectId })),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("rejects concurrent project changes, expired processing and publication after deletion", async () => {
    const { repository } = setup();
    const created = await repository.prepare(input({ accessMode: "password" }));
    await publish(repository, created.uploadId);
    await expect(
      repository.prepare({
        ...input({ action: "replace", projectId: created.projectId }),
        owner: { ...owner, id: "other" },
      }),
    ).rejects.toMatchObject({ code: "PROJECT_FORBIDDEN" });
    const replacement = await repository.prepare(
      input({ action: "replace", projectId: created.projectId, regeneratePassword: true }),
    );
    await expect(
      repository.prepare(input({ action: "replace", projectId: created.projectId })),
    ).rejects.toMatchObject({ code: "PROJECT_UPLOAD_CONFLICT" });
    await repository.requestCompletion(statusInput(replacement.uploadId));
    expect(
      await repository.publishUpload({
        uploadId: replacement.uploadId,
        now: replacement.expiresAt,
      }),
    ).toBe(false);
    expect(
      await repository.getStatus(statusInput(replacement.uploadId, replacement.expiresAt)),
    ).not.toHaveProperty("accessPassword");
    const pending = await repository.prepare(
      input({ action: "replace", projectId: created.projectId }),
    );
    await repository.requestCompletion(statusInput(pending.uploadId));
    await repository.deleteProject({ projectId: created.projectId, ownerUserId: owner.id });
    expect(await repository.publishUpload({ uploadId: pending.uploadId, now })).toBe(false);
  });
});
