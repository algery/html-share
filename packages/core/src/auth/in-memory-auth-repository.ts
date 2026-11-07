import type {
  AccessSessionRecord,
  AuthRepository,
  AuthStateRecord,
  DingTalkIdentity,
  SessionAudience,
} from "./contracts.js";

interface StoredState extends AuthStateRecord {
  expiresAt: Date;
  consumedAt?: Date;
}

interface StoredSession extends AccessSessionRecord {
  tokenDigest: string;
  revokedAt?: Date;
}

export class InMemoryAuthRepository implements AuthRepository {
  private readonly states = new Map<string, StoredState>();
  private readonly sessions = new Map<string, StoredSession>();
  private readonly users = new Map<
    string,
    { id: string; identity: DingTalkIdentity; tenantId: string }
  >();
  private nextUserId = 1;
  private nextSessionId = 1;

  async upsertUser(input: DingTalkIdentity & { tenantAppKeyRef: string; now: Date }) {
    const key = `${input.tenantAppKeyRef}:${input.dingtalkUserId}`;
    const existing = this.users.get(key);
    if (existing !== undefined) {
      existing.identity = {
        ...existing.identity,
        dingtalkUserId: input.dingtalkUserId,
        displayName: input.displayName,
        ...(input.dingtalkUnionId ? { dingtalkUnionId: input.dingtalkUnionId } : {}),
      };
      return { id: existing.id };
    }
    const user = {
      id: `user-${this.nextUserId++}`,
      identity: {
        dingtalkUserId: input.dingtalkUserId,
        displayName: input.displayName,
        ...(input.dingtalkUnionId ? { dingtalkUnionId: input.dingtalkUnionId } : {}),
      },
      tenantId: input.tenantAppKeyRef,
    };
    this.users.set(key, user);
    return { id: user.id };
  }

  async createAuthState(input: {
    stateDigest: string;
    audience: SessionAudience;
    returnPath: string;
    expiresAt: Date;
  }) {
    this.states.set(input.stateDigest, { ...input });
  }

  async consumeAuthState(input: { stateDigest: string; now: Date }) {
    const state = this.states.get(input.stateDigest);
    if (state === undefined || state.consumedAt !== undefined || state.expiresAt <= input.now) {
      return null;
    }
    state.consumedAt = input.now;
    return { audience: state.audience, returnPath: state.returnPath };
  }

  async createAccessSession(input: {
    userId: string;
    tokenDigest: string;
    audience: SessionAudience;
    expiresAt: Date;
  }) {
    const user = [...this.users.values()].find((entry) => entry.id === input.userId);
    if (user === undefined) {
      throw new Error("USER_NOT_FOUND");
    }
    this.sessions.set(input.tokenDigest, {
      id: `session-${this.nextSessionId++}`,
      audience: input.audience,
      expiresAt: input.expiresAt,
      tenantId: user.tenantId,
      tokenDigest: input.tokenDigest,
      user: { ...user.identity, id: user.id },
    });
  }

  async findAccessSession(input: { tokenDigest: string; audience: SessionAudience; now: Date }) {
    const session = this.sessions.get(input.tokenDigest);
    if (
      session === undefined ||
      session.audience !== input.audience ||
      session.expiresAt <= input.now ||
      session.revokedAt !== undefined
    ) {
      return null;
    }
    const user = [...this.users.values()].find((entry) => entry.id === session.user.id);
    return { ...session, user: { ...session.user, ...user?.identity } };
  }

  async revokeAccessSession(input: { tokenDigest: string; audience: SessionAudience; now: Date }) {
    const session = this.sessions.get(input.tokenDigest);
    if (session !== undefined && session.audience === input.audience) {
      session.revokedAt = input.now;
    }
  }
}
