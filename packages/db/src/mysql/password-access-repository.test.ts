import { describe, expect, it, vi } from "vitest";
import type { PasswordAccessTarget } from "@html-share/core";
import { createMysqlPasswordAccessRepository } from "./password-access-repository.js";
import type { MysqlClient, MysqlTransactionClient } from "./types.js";

function fixture() {
  const query = vi.fn();
  const create = vi.fn().mockResolvedValue({});
  const tx = {
    $queryRaw: query,
    passwordAccessGrant: { create },
  } as unknown as MysqlTransactionClient;
  const prisma = {
    $queryRaw: query,
    $transaction: (operation: (tx: MysqlTransactionClient) => Promise<unknown>) => operation(tx),
  } as unknown as MysqlClient;
  return { repository: createMysqlPasswordAccessRepository(prisma), query, create };
}

describe("MySQL password authorization identity and revalidation", () => {
  const target: PasswordAccessTarget = {
    projectId: "project",
    projectKey: "abc12",
    tenantId: "tenant",
    accessMode: "password",
    passwordVersion: 1,
    passwordHash: "verified-hash",
  };
  const relativePath = `${"目🙂".repeat(330)}/A.html`;
  const now = new Date("2026-11-04T00:00:00Z");
  const grant = {
    target,
    relativePath,
    grantHash: "grant",
    now,
    expiresAt: new Date(now.getTime() + 1000),
  };

  it.each([
    { passwordVersion: 2 },
    { passwordHash: "new-hash" },
    { accessMode: "organization" },
    { projectId: "different-project" },
    { tenantId: "different-tenant" },
  ])("does not mint a grant when the locked target changed: %j", async (change) => {
    const test = fixture();
    test.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...target, ...change, relativePath }]);
    await expect(test.repository.createGrant(grant)).resolves.toBe(false);
    expect(test.create).not.toHaveBeenCalled();
  });

  it.each([{ rows: [] }, { rows: [{ ...target, relativePath }] }])(
    "rejects removed files and expiry at the exact boundary",
    async ({ rows }) => {
      const test = fixture();
      test.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
      await expect(test.repository.createGrant({ ...grant, expiresAt: now })).resolves.toBe(false);
      expect(test.create).not.toHaveBeenCalled();
    },
  );

  it("rejects an aliased file digest before exposing target metadata", async () => {
    const test = fixture();
    test.query.mockResolvedValue([{ ...target, relativePath: relativePath.toLowerCase() }]);
    await expect(
      test.repository.findTarget({ projectKey: target.projectKey, relativePath }),
    ).rejects.toMatchObject({
      name: "DatabaseOperationError",
      message: "Database operation failed (identity)",
    });
  });

  it("rejects an aliased grant digest before exposing content metadata", async () => {
    const test = fixture();
    test.query.mockResolvedValue([
      {
        relativePath,
        contentHash: "hash",
        size: 7n,
        storageKey: "private/key",
        principal: "password:grant-id",
        grantHash: "another-grant",
      },
    ]);
    await expect(
      test.repository.authorizeFile({
        projectKey: target.projectKey,
        relativePath,
        tenantId: null,
        grantHash: "grant",
        now,
      }),
    ).rejects.toMatchObject({
      name: "DatabaseOperationError",
      message: "Database operation failed (identity)",
    });
  });

  it("keeps the complete long Unicode path and converts bigint only at the interface", async () => {
    const test = fixture();
    test.query.mockResolvedValue([
      {
        relativePath,
        contentHash: "hash",
        size: 2_147_483_648n,
        storageKey: "private/key",
        principal: "organization:tenant",
        grantHash: null,
      },
    ]);
    await expect(
      test.repository.authorizeFile({
        projectKey: target.projectKey,
        relativePath,
        tenantId: "tenant",
        grantHash: null,
        now,
      }),
    ).resolves.toEqual({
      file: { relativePath, contentHash: "hash", size: 2_147_483_648, storageKey: "private/key" },
      principal: "organization:tenant",
    });
  });
});
