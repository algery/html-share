import type { PlatformUserIdentity } from "../auth/contracts.js";

export type McpTokenStatus = "active" | "revoked";

export interface McpTokenSummary {
  id: string;
  name: string;
  status: McpTokenStatus;
  tokenSuffix: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface AuthenticatedMcpToken extends McpTokenSummary {
  user: PlatformUserIdentity;
}

export interface McpTokenRepository {
  createToken(input: {
    user: PlatformUserIdentity;
    name: string;
    tokenDigest: string;
    tokenSuffix: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<McpTokenSummary>;
  listTokens(input: { userId: string }): Promise<McpTokenSummary[]>;
  revokeToken(input: { tokenId: string; userId: string; revokedAt: Date }): Promise<boolean>;
  findActiveToken(input: { tokenDigest: string; now: Date }): Promise<AuthenticatedMcpToken | null>;
  recordTokenUse(input: { tokenId: string; usedAt: Date }): Promise<void>;
}
