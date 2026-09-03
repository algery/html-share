export type SessionAudience = "app" | "demo";

export interface DingTalkIdentity {
  dingtalkUserId: string;
  displayName: string;
}

export interface PlatformUserIdentity extends DingTalkIdentity {
  id: string;
}

export interface AuthStateRecord {
  audience: SessionAudience;
  returnPath: string;
}

export interface AccessSessionRecord {
  id: string;
  audience: SessionAudience;
  expiresAt: Date;
  tenantId: string;
  user: PlatformUserIdentity;
}

export interface AuthRepository {
  upsertUser(
    input: DingTalkIdentity & { tenantAppKeyRef: string; now: Date },
  ): Promise<{ id: string }>;
  createAuthState(input: {
    stateDigest: string;
    audience: SessionAudience;
    returnPath: string;
    expiresAt: Date;
  }): Promise<void>;
  consumeAuthState(input: { stateDigest: string; now: Date }): Promise<AuthStateRecord | null>;
  createAccessSession(input: {
    userId: string;
    tokenDigest: string;
    audience: SessionAudience;
    expiresAt: Date;
  }): Promise<void>;
  findAccessSession(input: {
    tokenDigest: string;
    audience: SessionAudience;
    now: Date;
  }): Promise<AccessSessionRecord | null>;
  revokeAccessSession(input: {
    tokenDigest: string;
    audience: SessionAudience;
    now: Date;
  }): Promise<void>;
}
