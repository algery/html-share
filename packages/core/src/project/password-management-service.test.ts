import { describe, expect, it, vi } from "vitest";

import { createPasswordCrypto } from "../access/password-crypto.js";
import {
  createPasswordManagementService,
  PasswordManagementError,
  projectPasswordContext,
  type PasswordManagementProject,
  type PasswordManagementRepository,
} from "./password-management-service.js";

const crypto = createPasswordCrypto(Buffer.alloc(32, 9).toString("base64"));

function fixture(overrides: Partial<PasswordManagementProject> = {}): PasswordManagementProject {
  return {
    accessMode: "organization",
    encryptedPassword: null,
    id: "project-1",
    ownerUserId: "owner-1",
    passwordVersion: 0,
    projectKey: "abc12",
    ...overrides,
  };
}

function setup(project: PasswordManagementProject | null) {
  const findOwnedActive = vi.fn().mockResolvedValue(project);
  const applyOwnedChange = vi.fn().mockResolvedValue("updated");
  const repository: PasswordManagementRepository = { applyOwnedChange, findOwnedActive };
  return {
    applyOwnedChange,
    service: createPasswordManagementService({
      now: () => new Date("2026-09-10T00:00:00Z"),
      passwordCrypto: crypto,
      repository,
    }),
  };
}

describe("password management service", () => {
  it("enables access with independent hash and recoverable ciphertext", async () => {
    const project = fixture();
    const { applyOwnedChange, service } = setup(project);
    const result = await service.changeOwnedProjectAccess({
      action: "enable",
      ownerUserId: project.ownerUserId,
      projectKey: project.projectKey,
      requestIp: "127.0.0.1",
      traceId: "trace-enable",
    });
    expect(result.outcome).toBe("updated");
    if (!("access" in result) || result.access.accessPassword === undefined) {
      throw new Error("Expected generated password");
    }
    const mutation = applyOwnedChange.mock.calls[0]?.[0];
    expect(mutation).toMatchObject({
      action: "enable",
      expectedPasswordVersion: 0,
      passwordVersion: 1,
    });
    expect(await crypto.verify(result.access.accessPassword, mutation.passwordHash)).toBe(true);
    expect(
      crypto.decrypt(
        mutation.encryptedPassword,
        projectPasswordContext({ ...project, passwordVersion: 1 }),
      ),
    ).toBe(result.access.accessPassword);
  });

  it("reads current passwords and identifies legacy projects without changing them", async () => {
    const password = "Abcd2345";
    const current = fixture({
      accessMode: "password",
      encryptedPassword: crypto.encrypt(
        password,
        projectPasswordContext({ id: "project-1", ownerUserId: "owner-1", passwordVersion: 2 }),
      ),
      passwordVersion: 2,
    });
    await expect(setup(current).service.readOwnedProjectAccess(current)).resolves.toEqual({
      accessMode: "password",
      accessPassword: password,
      passwordStatus: "available",
    });
    const legacy = setup({ ...current, encryptedPassword: null });
    await expect(legacy.service.readOwnedProjectAccess(current)).resolves.toEqual({
      accessMode: "password",
      passwordStatus: "unavailable",
    });
    expect(legacy.applyOwnedChange).not.toHaveBeenCalled();
  });

  it("rejects invalid transitions and preserves repository conflict outcomes", async () => {
    const organization = fixture();
    const invalid = setup(organization);
    await expect(
      invalid.service.changeOwnedProjectAccess({
        action: "regenerate",
        ownerUserId: organization.ownerUserId,
        projectKey: organization.projectKey,
        requestIp: "127.0.0.1",
        traceId: "trace-invalid",
      }),
    ).rejects.toEqual(new PasswordManagementError("INVALID_ACTION"));

    const conflict = setup(organization);
    conflict.applyOwnedChange.mockResolvedValue("upload_conflict");
    await expect(
      conflict.service.changeOwnedProjectAccess({
        action: "enable",
        ownerUserId: organization.ownerUserId,
        projectKey: organization.projectKey,
        requestIp: "127.0.0.1",
        traceId: "trace-conflict",
      }),
    ).resolves.toEqual({ outcome: "upload_conflict" });
  });

  it("supports consistent instances and fails closed for wrong keys or tampering", async () => {
    const password = "Abcd2345";
    const project = fixture({
      accessMode: "password",
      encryptedPassword: crypto.encrypt(
        password,
        projectPasswordContext({ id: "project-1", ownerUserId: "owner-1", passwordVersion: 1 }),
      ),
      passwordVersion: 1,
    });
    await expect(setup(project).service.readOwnedProjectAccess(project)).resolves.toMatchObject({
      accessPassword: password,
      passwordStatus: "available",
    });
    const wrongKeyService = createPasswordManagementService({
      passwordCrypto: createPasswordCrypto(Buffer.alloc(32, 8).toString("base64")),
      repository: {
        applyOwnedChange: vi.fn(),
        findOwnedActive: vi.fn().mockResolvedValue(project),
      },
    });
    await expect(wrongKeyService.readOwnedProjectAccess(project)).rejects.toEqual(
      new PasswordManagementError("DECRYPTION_FAILED"),
    );
    const tampered = { ...project, encryptedPassword: `${project.encryptedPassword}x` };
    await expect(setup(tampered).service.readOwnedProjectAccess(tampered)).rejects.toEqual(
      new PasswordManagementError("DECRYPTION_FAILED"),
    );
  });
});
