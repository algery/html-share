import type { MysqlClient } from "./types.js";
import type {
  AuthenticatedMcpToken,
  McpTokenRepository,
  McpTokenSummary,
  PlatformUserIdentity,
} from "@html-share/core";

import { McpTokenStatus } from "../generated/prisma-mysql/client.js";
import { assertSameText, textDigest } from "./path-identity.js";

export function createMysqlMcpTokenRepository(prisma: MysqlClient): McpTokenRepository {
  return {
    async createToken(input) {
      const token = await prisma.mcpToken.create({
        data: {
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
          name: input.name,
          tokenDigest: input.tokenDigest,
          tokenSuffix: input.tokenSuffix,
          userId: input.user.id,
        },
      });
      return toSummary(token);
    },

    async listTokens(input) {
      const tokens = await prisma.mcpToken.findMany({
        orderBy: { createdAt: "desc" },
        where: { userId: input.userId },
      });
      return tokens.map(toSummary);
    },

    async revokeToken(input) {
      const result = await prisma.mcpToken.updateMany({
        data: { revokedAt: input.revokedAt, status: McpTokenStatus.REVOKED },
        where: {
          id: input.tokenId,
          revokedAt: null,
          status: McpTokenStatus.ACTIVE,
          userId: input.userId,
        },
      });
      return result.count === 1;
    },

    async findActiveToken(input) {
      const rows = await prisma.$queryRaw<{ id: string; tokenDigest: string }[]>`
        SELECT id, token_digest AS tokenDigest FROM mcp_tokens
        WHERE token_digest_hash = ${textDigest(input.tokenDigest)} LIMIT 1`;
      const identity = rows[0];
      if (!identity) return null;
      assertSameText(identity.tokenDigest, input.tokenDigest);
      const token = await prisma.mcpToken.findFirst({
        include: { user: true },
        where: {
          id: identity.id,
          expiresAt: { gt: input.now },
          revokedAt: null,
          status: McpTokenStatus.ACTIVE,
          tokenDigest: input.tokenDigest,
          user: { status: "ACTIVE", tenant: { status: "ACTIVE" } },
        },
      });
      return token === null ? null : toAuthenticatedToken(token);
    },

    async recordTokenUse(input) {
      await prisma.mcpToken.updateMany({
        data: { lastUsedAt: input.usedAt },
        where: { id: input.tokenId, revokedAt: null, status: McpTokenStatus.ACTIVE },
      });
    },
  };
}

function toSummary(token: {
  createdAt: Date;
  expiresAt: Date;
  id: string;
  lastUsedAt: Date | null;
  name: string;
  revokedAt: Date | null;
  status: McpTokenStatus;
  tokenSuffix: string;
}): McpTokenSummary {
  return {
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    id: token.id,
    lastUsedAt: token.lastUsedAt,
    name: token.name,
    revokedAt: token.revokedAt,
    status: token.status === McpTokenStatus.ACTIVE ? "active" : "revoked",
    tokenSuffix: token.tokenSuffix,
  };
}

function toAuthenticatedToken(token: {
  createdAt: Date;
  expiresAt: Date;
  id: string;
  lastUsedAt: Date | null;
  name: string;
  revokedAt: Date | null;
  status: McpTokenStatus;
  tokenSuffix: string;
  user: PlatformUserIdentity;
}): AuthenticatedMcpToken {
  return { ...toSummary(token), user: token.user };
}
