import {
  AccountLinkError,
  accountContactCutoff,
  normalizeAccountContacts,
} from "./account-link.js";
import type {
  AccessSessionRecord,
  AuthRepository,
  AuthStateRecord,
  DingTalkIdentity,
  FeishuIdentity,
  PlatformUserIdentity,
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
    { id: string; identity: PlatformUserIdentity; tenantId: string; feishuKey?: string }
  >();
  private nextUserId = 1;
  private nextSessionId = 1;

  private readonly contacts = new Map<
    string,
    {
      userId: string;
      tenantId: string;
      phone: string | null;
      email: string | null;
      observedAt: Date;
    }
  >();

  async upsertUser(input: DingTalkIdentity & { tenantAppKeyRef: string; now: Date }) {
    return this.upsertIdentity(input);
  }

  async upsertFeishuUser(input: FeishuIdentity & { tenantAppKeyRef: string; now: Date }) {
    return this.upsertIdentity(input);
  }

  private upsertIdentity(
    input: (DingTalkIdentity | FeishuIdentity) & { tenantAppKeyRef: string; now: Date },
  ) {
    const feishu = "feishuOpenId" in input;
    const provider = feishu ? "feishu" : "dingtalk";
    const feishuKey = feishu
      ? JSON.stringify([input.feishuAppId, input.feishuTenantKey, input.feishuOpenId])
      : "";
    const contacts = normalizeAccountContacts(input);
    let user = [...this.users.values()].find(
      (u) =>
        u.tenantId === input.tenantAppKeyRef &&
        (feishu ? u.feishuKey === feishuKey : u.identity.dingtalkUserId === input.dingtalkUserId),
    );
    if (!user) {
      const ids = new Set(
        [...this.contacts.values()]
          .filter(
            (c) =>
              c.tenantId === input.tenantAppKeyRef &&
              c.observedAt >= accountContactCutoff(input.now) &&
              ((contacts.phone !== null && c.phone === contacts.phone) ||
                (contacts.email !== null && c.email === contacts.email)),
          )
          .map((c) => c.userId),
      );
      if (ids.size > 1) throw new AccountLinkError("ACCOUNT_LINK_CONFLICT");
      const id = [...ids][0];
      user = id ? this.users.get(id) : undefined;
      if (user && (feishu ? user.feishuKey !== undefined : user.identity.dingtalkUserId !== null))
        throw new AccountLinkError("ACCOUNT_LINK_CONFLICT");
    }
    if (!user) {
      const id = `user-${this.nextUserId++}`;
      user = {
        id,
        identity: { id, dingtalkUserId: null, displayName: input.displayName },
        tenantId: input.tenantAppKeyRef,
      };
      this.users.set(id, user);
    }
    user.identity.displayName = input.displayName;
    if (feishu) user.feishuKey = feishuKey;
    else {
      user.identity.dingtalkUserId = input.dingtalkUserId;
      if (input.dingtalkUnionId) user.identity.dingtalkUnionId = input.dingtalkUnionId;
    }
    this.contacts.set(`${user.id}:${provider}`, {
      userId: user.id,
      tenantId: user.tenantId,
      ...contacts,
      observedAt: input.now,
    });
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
