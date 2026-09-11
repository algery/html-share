import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PasswordAccessRepository, PasswordAccessTarget } from "./contracts.js";
import { createPasswordAccessService } from "./password-access-service.js";
import { createPasswordCrypto } from "./password-crypto.js";

const path = { projectKey: "ab123", relativePath: "目录/a file.html" };
const target: PasswordAccessTarget = {
  projectId: "project-uuid",
  tenantId: "tenant-uuid",
  projectKey: path.projectKey,
  accessMode: "password",
  passwordVersion: 1,
  passwordHash: "scrypt-hash",
};
function fixture() {
  const repository = {
    findTarget: vi.fn<PasswordAccessRepository["findTarget"]>().mockResolvedValue(target),
    createGrant: vi.fn<PasswordAccessRepository["createGrant"]>().mockResolvedValue(true),
    authorizeFile: vi.fn<PasswordAccessRepository["authorizeFile"]>().mockResolvedValue(null),
  };
  const verify = vi.fn().mockResolvedValue(true);
  const now = new Date("2026-09-09T00:00:00Z");
  return {
    repository,
    verify,
    now,
    service: createPasswordAccessService({
      repository,
      passwordCrypto: { verify },
      now: () => now,
    }),
  };
}

describe("password access service", () => {
  it("issues anonymous random credentials for eight hours and persists only a hash", async () => {
    const { repository, service, verify, now } = fixture();
    const issued = await service.verifyPassword({ ...path, password: "  Abcd2345\n" });
    expect(verify).toHaveBeenCalledWith("Abcd2345", "scrypt-hash");
    expect(issued).toMatchObject({
      projectId: target.projectId,
      projectKey: path.projectKey,
      expiresAt: new Date(now.getTime() + 28_800_000),
    });
    expect(Buffer.from(required(issued).token, "base64url")).toHaveLength(32);
    expect(repository.createGrant).toHaveBeenCalledWith({
      target,
      relativePath: path.relativePath,
      now,
      expiresAt: required(issued).expiresAt,
      grantHash: createHash("sha256").update(required(issued).token).digest("hex"),
    });
    expect(JSON.stringify(repository.createGrant.mock.calls)).not.toContain(required(issued).token);
    const another = await service.verifyPassword({ ...path, password: "Abcd2345" });
    expect(required(another).token).not.toBe(required(issued).token);
  });

  it("preserves case and rejects wrong passwords using real scrypt", async () => {
    const { repository } = fixture();
    const crypto = createPasswordCrypto(Buffer.alloc(32, 9).toString("base64"));
    let generated = await crypto.generate();
    while (!/[a-z]/i.test(generated.password)) generated = await crypto.generate();
    repository.findTarget.mockResolvedValue({ ...target, passwordHash: generated.hash });
    const service = createPasswordAccessService({ repository, passwordCrypto: crypto });
    const flipped = generated.password.replace(/[a-z]/i, (letter) =>
      letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
    );
    expect(await service.verifyPassword({ ...path, password: flipped })).toBeNull();
    expect(await service.verifyPassword({ ...path, password: "wrong" })).toBeNull();
    expect(
      await service.verifyPassword({ ...path, password: ` \t${generated.password}\n` }),
    ).not.toBeNull();
  });

  it.each(["", "  ", "a".repeat(257)])(
    "rejects empty or unbounded input before hashing",
    async (password) => {
      const { service, verify } = fixture();
      expect(await service.verifyPassword({ ...path, password })).toBeNull();
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it("does not issue for an inactive target, organization mode, bad password or a lost publication race", async () => {
    const { service, repository, verify } = fixture();
    for (const value of [
      null,
      { ...target, accessMode: "organization" as const },
      { ...target, passwordHash: null },
    ]) {
      repository.findTarget.mockResolvedValue(value);
      expect(await service.verifyPassword({ ...path, password: "Abcd2345" })).toBeNull();
    }
    expect(verify).not.toHaveBeenCalled();
    repository.findTarget.mockResolvedValue(target);
    verify.mockResolvedValue(false);
    expect(await service.verifyPassword({ ...path, password: "Abcd2345" })).toBeNull();
    expect(repository.createGrant).not.toHaveBeenCalled();
    verify.mockResolvedValue(true);
    repository.createGrant.mockResolvedValue(false);
    expect(await service.verifyPassword({ ...path, password: "Abcd2345" })).toBeNull();
  });

  it("authorizes reads without scrypt or policy preflight and hashes only canonical tokens", async () => {
    const { service, repository, verify, now } = fixture();
    const token = Buffer.alloc(32, 5).toString("base64url");
    await service.authorize({ ...path, token });
    expect(repository.authorizeFile).toHaveBeenCalledWith({
      ...path,
      tenantId: null,
      now,
      grantHash: createHash("sha256").update(token).digest("hex"),
    });
    expect(verify).not.toHaveBeenCalled();
    expect(repository.findTarget).not.toHaveBeenCalled();
    repository.authorizeFile.mockClear();
    for (const token of ["", "x".repeat(43), "a".repeat(44), "!".repeat(43)]) {
      expect(await service.authorize({ ...path, token })).toBeNull();
    }
    expect(repository.authorizeFile).not.toHaveBeenCalled();
    await service.authorize({ ...path, token: "bad", tenantId: "trusted-tenant" });
    expect(repository.authorizeFile).toHaveBeenCalledWith({
      ...path,
      tenantId: "trusted-tenant",
      grantHash: null,
      now,
    });
  });

  it.each(["../index.html", "/index.html", "a//b.html", "a/./b", "a\\b", "a\u0000b", ""])(
    "rejects unsafe paths before any database request: %s",
    async (relativePath) => {
      const { service, repository } = fixture();
      const input = { ...path, relativePath };
      expect(await service.getTarget(input)).toBeNull();
      expect(await service.verifyPassword({ ...input, password: "Abcd2345" })).toBeNull();
      expect(await service.authorize({ ...input, tenantId: "tenant" })).toBeNull();
      expect(repository.findTarget).not.toHaveBeenCalled();
      expect(repository.authorizeFile).not.toHaveBeenCalled();
    },
  );
});

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected a successful credential");
  return value;
}
