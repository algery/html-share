import { describe, expect, it, vi } from "vitest";
import { createMysqlAuthRepository } from "./auth-repository.js";
import type { MysqlClient, MysqlTransactionClient } from "./types.js";

function fixture() {
  const query = vi.fn();
  const execute = vi.fn().mockResolvedValue(1);
  const updateUser = vi.fn().mockResolvedValue({});
  const findUser = vi.fn();
  const contact = vi.fn().mockResolvedValue({});
  const updateState = vi.fn().mockResolvedValue({});
  const tx = {
    $queryRaw: query,
    $executeRaw: execute,
    user: { update: updateUser, findFirst: findUser },
    accountContact: { upsert: contact },
    authState: { update: updateState },
  } as unknown as MysqlTransactionClient;
  const transaction = vi.fn((operation: (tx: MysqlTransactionClient) => Promise<unknown>) =>
    operation(tx),
  );
  const prisma = { $transaction: transaction } as unknown as MysqlClient;
  return {
    repository: createMysqlAuthRepository(prisma),
    query,
    execute,
    updateUser,
    updateState,
    findUser,
  };
}

describe("MySQL authentication identities", () => {
  const now = new Date("2026-11-04T00:00:00Z");
  const input = {
    now,
    tenantAppKeyRef: "组织🙂 App",
    dingtalkUserId: "员工A🙂",
    displayName: "显示名",
  };

  it("does not alter an existing user when a tenant digest resolves to another full identity", async () => {
    const test = fixture();
    test.query.mockResolvedValueOnce([{ id: "tenant", appKey: "different identity" }]);
    await expect(test.repository.upsertUser(input)).rejects.toMatchObject({
      name: "DatabaseOperationError",
      message: "Database operation failed (identity)",
    });
    expect(test.execute).toHaveBeenCalledTimes(1);
    expect(test.updateUser).not.toHaveBeenCalled();
  });

  it("does not overwrite a different full DingTalk identity returned by the database", async () => {
    const test = fixture();
    test.query.mockResolvedValueOnce([
      { id: "tenant", appKey: input.tenantAppKeyRef, status: "ACTIVE" },
    ]);
    test.findUser.mockResolvedValue({
      id: "user",
      dingtalkUserId: "different identity",
      status: "ACTIVE",
    });
    await expect(test.repository.upsertUser(input)).rejects.toMatchObject({
      code: "ACCOUNT_LINK_CONFLICT",
    });
    expect(test.updateUser).not.toHaveBeenCalled();
  });

  it("retains complete Unicode identity data and the persisted user id on repeated login", async () => {
    const test = fixture();
    test.query.mockResolvedValueOnce([
      { id: "tenant", appKey: input.tenantAppKeyRef, status: "ACTIVE" },
    ]);
    test.findUser.mockResolvedValue({
      id: "existing-user",
      dingtalkUserId: input.dingtalkUserId,
      status: "ACTIVE",
    });
    test.updateUser.mockResolvedValue({ id: "existing-user" });
    await expect(test.repository.upsertUser(input)).resolves.toEqual({ id: "existing-user" });
    expect(test.execute.mock.calls[0]).toContain(input.tenantAppKeyRef);
    expect(test.findUser).toHaveBeenCalledWith({
      where: { tenantId: "tenant", dingtalkUserId: input.dingtalkUserId },
    });
    expect(test.updateUser).toHaveBeenCalledWith({
      where: { id: "existing-user" },
      data: {
        displayName: input.displayName,
        lastLoginAt: now,
        dingtalkUserId: input.dingtalkUserId,
      },
    });
  });

  it("does not consume a different full state value on a digest collision", async () => {
    const test = fixture();
    test.query.mockResolvedValueOnce([
      {
        id: "state",
        stateDigest: "other",
        audience: "DEMO",
        returnPath: "/abc12/index.html",
      },
    ]);
    await expect(
      test.repository.consumeAuthState({ now, stateDigest: "expected" }),
    ).rejects.toMatchObject({
      name: "DatabaseOperationError",
      message: "Database operation failed (identity)",
    });
    expect(test.updateState).not.toHaveBeenCalled();
  });

  it("returns no replay result and preserves exact audience and nested return path", async () => {
    const test = fixture();
    const returnPath = "/abc12/目录🙂/A B.html";
    test.query
      .mockResolvedValueOnce([
        {
          id: "state",
          stateDigest: "digest",
          audience: "DEMO",
          returnPath,
        },
      ])
      .mockResolvedValueOnce([]);
    await expect(test.repository.consumeAuthState({ now, stateDigest: "digest" })).resolves.toEqual(
      { audience: "demo", returnPath },
    );
    await expect(
      test.repository.consumeAuthState({ now, stateDigest: "digest" }),
    ).resolves.toBeNull();
    expect(test.updateState).toHaveBeenCalledTimes(1);
  });
});
