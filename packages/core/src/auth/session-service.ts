import { createHash, createHmac, randomBytes } from "node:crypto";

import type {
  AccessSessionRecord,
  AuthRepository,
  DingTalkIdentity,
  SessionAudience,
} from "./contracts.js";

const AUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export class AuthenticationError extends Error {
  constructor(readonly code: "AUTH_STATE_INVALID" | "SESSION_INVALID" | "RETURN_PATH_INVALID") {
    super(code);
    this.name = "AuthenticationError";
  }
}

export interface AuthSessionServiceOptions {
  repository: AuthRepository;
  stateSecret: string;
  tenantAppKeyRef: string;
  now?: () => Date;
}

export function createAuthSessionService(options: AuthSessionServiceOptions) {
  const now = options.now ?? (() => new Date());

  return {
    async beginAuthorization(input: { audience: SessionAudience; returnPath: string }) {
      assertReturnPath(input.returnPath);
      const state = randomBytes(32).toString("base64url");
      const createdAt = now();
      await options.repository.createAuthState({
        stateDigest: digestState(state, options.stateSecret),
        audience: input.audience,
        returnPath: input.returnPath,
        expiresAt: new Date(createdAt.getTime() + AUTH_STATE_TTL_MS),
      });
      return { state };
    },

    async finishAuthorization(input: {
      audience: SessionAudience;
      state: string;
      identity: DingTalkIdentity;
    }) {
      const completedAt = now();
      const state = await options.repository.consumeAuthState({
        stateDigest: digestState(input.state, options.stateSecret),
        now: completedAt,
      });
      if (state === null) {
        throw new AuthenticationError("AUTH_STATE_INVALID");
      }
      if (state.audience !== input.audience) {
        throw new AuthenticationError("AUTH_STATE_INVALID");
      }

      const user = await options.repository.upsertUser({
        ...input.identity,
        now: completedAt,
        tenantAppKeyRef: options.tenantAppKeyRef,
      });
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(completedAt.getTime() + SESSION_TTL_MS);
      await options.repository.createAccessSession({
        userId: user.id,
        tokenDigest: digestToken(token),
        audience: state.audience,
        expiresAt,
      });

      return { audience: state.audience, expiresAt, returnPath: state.returnPath, token };
    },

    async getSession(input: { token: string | undefined; audience: SessionAudience }) {
      if (input.token === undefined || input.token.length === 0) {
        return null;
      }
      return options.repository.findAccessSession({
        audience: input.audience,
        now: now(),
        tokenDigest: digestToken(input.token),
      });
    },

    async logout(input: { token: string | undefined; audience: SessionAudience }) {
      if (input.token === undefined || input.token.length === 0) {
        return;
      }
      await options.repository.revokeAccessSession({
        audience: input.audience,
        now: now(),
        tokenDigest: digestToken(input.token),
      });
    },
  };
}

export type AuthSessionService = ReturnType<typeof createAuthSessionService>;

function assertReturnPath(returnPath: string) {
  if (
    !returnPath.startsWith("/") ||
    returnPath.startsWith("//") ||
    returnPath.includes("\\") ||
    returnPath.includes("\u0000")
  ) {
    throw new AuthenticationError("RETURN_PATH_INVALID");
  }
}

function digestState(state: string, secret: string) {
  return createHmac("sha256", secret).update(state).digest("base64url");
}

function digestToken(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

export type { AccessSessionRecord };
