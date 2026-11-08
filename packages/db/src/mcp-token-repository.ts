import type {
  AuthenticatedMcpToken,
  McpTokenRepository,
  McpTokenSummary,
  PlatformUserIdentity,
} from "@html-share/core";

import { McpTokenStatus, type PrismaClient } from "./generated/prisma/client.js";

export function createMcpTokenRepository(prisma: PrismaClient): McpTokenRepository {
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
      const token = await prisma.mcpToken.findFirst({
        include: { user: true },
        where: {
          OR: [{ expiresAt: null }, { expiresAt: { gt: input.now } }],
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
  expiresAt: Date | null;
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
  expiresAt: Date | null;
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
