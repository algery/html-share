import type { AuthenticatedMcpToken, McpTokenRepository, McpTokenSummary } from "./contracts.js";

interface StoredToken extends AuthenticatedMcpToken {
  tokenDigest: string;
}

export class InMemoryMcpTokenRepository implements McpTokenRepository {
  private readonly tokens = new Map<string, StoredToken>();
  private nextTokenId = 1;

  async createToken(input: {
    user: AuthenticatedMcpToken["user"];
    name: string;
    tokenDigest: string;
    tokenSuffix: string;
    expiresAt: Date;
    createdAt: Date;
  }) {
    const token: StoredToken = {
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      id: `mcp-token-${this.nextTokenId++}`,
      lastUsedAt: null,
      name: input.name,
      revokedAt: null,
      status: "active",
      tokenDigest: input.tokenDigest,
      tokenSuffix: input.tokenSuffix,
      user: { ...input.user },
    };
    this.tokens.set(token.id, token);
    return copySummary(token);
  }

  async listTokens(input: { userId: string }) {
    return [...this.tokens.values()]
      .filter((token) => token.user.id === input.userId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map(copySummary);
  }

  async revokeToken(input: { tokenId: string; userId: string; revokedAt: Date }) {
    const token = this.tokens.get(input.tokenId);
    if (token === undefined || token.user.id !== input.userId || token.status !== "active") {
      return false;
    }
    token.status = "revoked";
    token.revokedAt = input.revokedAt;
    return true;
  }

  async findActiveToken(input: { tokenDigest: string; now: Date }) {
    const token = [...this.tokens.values()].find(
      (entry) => entry.tokenDigest === input.tokenDigest,
    );
    if (
      token === undefined ||
      token.status !== "active" ||
      token.expiresAt <= input.now ||
      token.revokedAt !== null
    ) {
      return null;
    }
    return copyAuthenticatedToken(token);
  }

  async recordTokenUse(input: { tokenId: string; usedAt: Date }) {
    const token = this.tokens.get(input.tokenId);
    if (token !== undefined && token.status === "active" && token.revokedAt === null) {
      token.lastUsedAt = input.usedAt;
    }
  }
}

function copySummary(token: StoredToken): McpTokenSummary {
  return {
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    id: token.id,
    lastUsedAt: token.lastUsedAt,
    name: token.name,
    revokedAt: token.revokedAt,
    status: token.status,
    tokenSuffix: token.tokenSuffix,
  };
}

function copyAuthenticatedToken(token: StoredToken): AuthenticatedMcpToken {
  return { ...copySummary(token), user: { ...token.user } };
}
