import { createHmac, randomBytes } from "node:crypto";

import type { PlatformUserIdentity } from "../auth/contracts.js";
import type { AuthenticatedMcpToken, McpTokenRepository, McpTokenSummary } from "./contracts.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_NAME_MAX_LENGTH = 40;

export class McpTokenError extends Error {
  constructor(readonly code: "TOKEN_NAME_INVALID" | "TOKEN_VALIDITY_INVALID") {
    super(code);
    this.name = "McpTokenError";
  }
}

export interface McpTokenServiceOptions {
  repository: McpTokenRepository;
  hashSecret: string;
  now?: () => Date;
}

export function createMcpTokenService(options: McpTokenServiceOptions) {
  const now = options.now ?? (() => new Date());

  return {
    async createToken(input: {
      user: PlatformUserIdentity;
      name: string;
      expiresInDays?: unknown;
    }) {
      const name = normalizeTokenName(input.name);
      const createdAt = now();
      const expiresAt = resolveExpiration(createdAt, input.expiresInDays);
      const token = `hsp_${randomBytes(32).toString("base64url")}`;
      const summary = await options.repository.createToken({
        createdAt,
        expiresAt,
        name,
        tokenDigest: digestToken(token, options.hashSecret),
        tokenSuffix: token.slice(-6),
        user: input.user,
      });
      return { summary, token };
    },

    listTokens(input: { userId: string }) {
      return options.repository.listTokens(input);
    },

    revokeToken(input: { tokenId: string; userId: string }) {
      return options.repository.revokeToken({ ...input, revokedAt: now() });
    },

    authenticate(input: { token: string }): Promise<AuthenticatedMcpToken | null> {
      if (!isMcpToken(input.token)) {
        return Promise.resolve(null);
      }
      return options.repository.findActiveToken({
        now: now(),
        tokenDigest: digestToken(input.token, options.hashSecret),
      });
    },

    recordTokenUse(input: { tokenId: string }) {
      return options.repository.recordTokenUse({ tokenId: input.tokenId, usedAt: now() });
    },
  };
}

export type McpTokenService = ReturnType<typeof createMcpTokenService>;

export function toTokenResponse(token: McpTokenSummary) {
  return {
    createdAt: token.createdAt.toISOString(),
    expiresAt: token.expiresAt?.toISOString() ?? null,
    id: token.id,
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    name: token.name,
    revokedAt: token.revokedAt?.toISOString() ?? null,
    status: token.status,
    tokenSuffix: token.tokenSuffix,
  };
}

function resolveExpiration(createdAt: Date, expiresInDays: unknown = 30) {
  if (expiresInDays === "never") return null;
  if (expiresInDays !== 1 && expiresInDays !== 7 && expiresInDays !== 15 && expiresInDays !== 30) {
    throw new McpTokenError("TOKEN_VALIDITY_INVALID");
  }
  return new Date(createdAt.getTime() + expiresInDays * DAY_MS);
}

function normalizeTokenName(value: string) {
  const name = value.trim();
  if (name.length < 1 || name.length > TOKEN_NAME_MAX_LENGTH) {
    throw new McpTokenError("TOKEN_NAME_INVALID");
  }
  return name;
}

function isMcpToken(value: string) {
  return /^hsp_[A-Za-z0-9_-]{43}$/.test(value);
}

function digestToken(token: string, hashSecret: string) {
  return createHmac("sha256", hashSecret).update(token).digest("base64url");
}
