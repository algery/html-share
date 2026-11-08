import { describe, expect, it, vi } from "vitest";
import { createMysqlAuthRepository } from "./auth-repository.js";
import { createMysqlMcpTokenRepository } from "./mcp-token-repository.js";
import { textDigest } from "./path-identity.js";
import type { MysqlClient } from "./types.js";

function fixture(tokenDigest = "matching") {
  const query = vi.fn().mockResolvedValue([{ id: "record", tokenDigest }]);
  const find = vi.fn().mockResolvedValue(null);
  const update = vi.fn().mockResolvedValue({ count: 1 });
  const client = {
    $queryRaw: query,
    accessSession: { findFirst: find, updateMany: update },
    mcpToken: { findFirst: find },
  } as unknown as MysqlClient;
  return {
    query,
    find,
    update,
    auth: createMysqlAuthRepository(client),
    tokens: createMysqlMcpTokenRepository(client),
  };
}

describe("MySQL token digest index lookup", () => {
  const now = new Date();
  it.each(["session", "token"])(
    "locates %s by its generated digest index before checking lifecycle",
    async (kind) => {
      const test = fixture();
      if (kind === "session")
        await test.auth.findAccessSession({ audience: "app", tokenDigest: "matching", now });
      else await test.tokens.findActiveToken({ tokenDigest: "matching", now });
      expect(test.query.mock.calls[0]?.[0].join("?")).toContain("token_digest_hash =");
      expect(test.query.mock.calls[0]?.[1]).toEqual(textDigest("matching"));
      expect(test.find.mock.calls[0]?.[0]).toMatchObject({
        where: {
          id: "record",
          tokenDigest: "matching",
          ...(kind === "session"
            ? { expiresAt: { gt: now } }
            : { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }),
          revokedAt: null,
          user: { status: "ACTIVE", tenant: { status: "ACTIVE" } },
        },
      });
    },
  );
  it.each(["session", "token", "logout"])(
    "rejects a %s hash hit with a different original value before any side effect",
    async (kind) => {
      const test = fixture("collision");
      const operation =
        kind === "session"
          ? test.auth.findAccessSession({ audience: "app", tokenDigest: "matching", now })
          : kind === "token"
            ? test.tokens.findActiveToken({ tokenDigest: "matching", now })
            : test.auth.revokeAccessSession({ audience: "app", tokenDigest: "matching", now });
      await expect(operation).rejects.toThrow("Database operation failed (identity)");
      expect(test.find).not.toHaveBeenCalled();
      expect(test.update).not.toHaveBeenCalled();
    },
  );
  it("revokes only the indexed identity and rechecks the original value/audience", async () => {
    const test = fixture();
    await test.auth.revokeAccessSession({ audience: "app", tokenDigest: "matching", now });
    expect(test.update).toHaveBeenCalledWith({
      where: { id: "record", audience: "APP", revokedAt: null, tokenDigest: "matching" },
      data: { revokedAt: now },
    });
  });
});
