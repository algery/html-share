import { encryptHandoffTicket, decryptHandoffTicket } from "./handoff-ticket.js";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  AccessSessionRecord,
  AuthRepository,
  DingTalkIdentity,
  FeishuIdentity,
  SessionAudience,
} from "./contracts.js";

const AUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_HANDOFF_TTL_MS = 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export class AuthenticationError extends Error {
  constructor(
    readonly code:
      "AUTH_STATE_INVALID" | "SESSION_HANDOFF_INVALID" | "SESSION_INVALID" | "RETURN_PATH_INVALID",
  ) {
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
  const handoffKey = createHash("sha256")
    .update("html-share:session-handoff-key:v1\0")
    .update(options.stateSecret)
    .digest();

  async function beginAuthorization(
    input: { audience: SessionAudience; returnPath: string },
    provider = "dingtalk",
  ) {
    assertReturnPath(input.returnPath);
    const state = randomBytes(32).toString("base64url");
    const createdAt = now();
    await options.repository.createAuthState({
      stateDigest: digestState(state, options.stateSecret, provider),
      audience: input.audience,
      returnPath: input.returnPath,
      expiresAt: new Date(createdAt.getTime() + AUTH_STATE_TTL_MS),
    });
    return { state };
  }

  async function getSession(input: { token: string | undefined; audience: SessionAudience }) {
    if (input.token === undefined || input.token.length === 0) return null;
    return options.repository.findAccessSession({
      audience: input.audience,
      now: now(),
      tokenDigest: digestToken(input.token),
    });
  }

  return {
    beginAuthorization,
    beginFeishuAuthorization(input: { audience: SessionAudience; returnPath: string }) {
      return beginAuthorization(input, "feishu");
    },
    async finishFeishuAuthorization(input: {
      audience: SessionAudience;
      state: string;
      resolveIdentity: (authorization: { returnPath: string }) => Promise<FeishuIdentity>;
    }) {
      const state = await options.repository.consumeAuthState({
        stateDigest: digestState(input.state, options.stateSecret, "feishu"),
        now: now(),
      });
      if (state === null || state.audience !== input.audience)
        throw new AuthenticationError("AUTH_STATE_INVALID");
      const identity = await input.resolveIdentity({ returnPath: state.returnPath });
      const completedAt = now();
      const user = await options.repository.upsertFeishuUser({
        ...identity,
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

    getSession,

    async beginSessionHandoff(input: {
      returnPath: string;
      sourceAudience: SessionAudience;
      sourceToken: string | undefined;
      targetAudience: SessionAudience;
    }) {
      assertReturnPath(input.returnPath);
      if (input.sourceAudience === input.targetAudience) {
        throw new AuthenticationError("SESSION_HANDOFF_INVALID");
      }
      const sourceSession = await getSession({
        audience: input.sourceAudience,
        token: input.sourceToken,
      });
      if (sourceSession === null) return null;
      const authorization = await beginAuthorization({
        audience: input.targetAudience,
        returnPath: input.returnPath,
      });
      const expiresAt = new Date(now().getTime() + SESSION_HANDOFF_TTL_MS);
      return {
        expiresAt,
        ticket: encryptHandoffTicket(
          {
            expiresAt: expiresAt.getTime(),
            sourceAudience: input.sourceAudience,
            state: authorization.state,
            targetAudience: input.targetAudience,
            userId: sourceSession.user.id,
            version: 1,
          },
          handoffKey,
        ),
      };
    },

    async finishSessionHandoff(input: { targetAudience: SessionAudience; ticket: string }) {
      const completedAt = now();
      const payload = decryptHandoffTicket(input.ticket, handoffKey);
      if (
        payload === null ||
        payload.targetAudience !== input.targetAudience ||
        payload.sourceAudience === input.targetAudience ||
        payload.expiresAt <= completedAt.getTime()
      ) {
        throw new AuthenticationError("SESSION_HANDOFF_INVALID");
      }
      const state = await options.repository.consumeAuthState({
        stateDigest: digestState(payload.state, options.stateSecret),
        now: completedAt,
      });
      if (state === null || state.audience !== input.targetAudience) {
        throw new AuthenticationError("SESSION_HANDOFF_INVALID");
      }
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(completedAt.getTime() + SESSION_TTL_MS);
      await options.repository.createAccessSession({
        userId: payload.userId,
        tokenDigest: digestToken(token),
        audience: state.audience,
        expiresAt,
      });
      return { audience: state.audience, expiresAt, returnPath: state.returnPath, token };
    },

    createCsrfToken(input: { audience: SessionAudience; token: string | undefined }) {
      if (input.token === undefined || input.token.length === 0) return null;
      return digestCsrfToken(input.token, input.audience, options.stateSecret);
    },

    validateCsrfToken(input: {
      audience: SessionAudience;
      csrfToken: string | undefined;
      token: string | undefined;
    }) {
      if (input.csrfToken === undefined || input.token === undefined || input.token.length === 0)
        return false;
      const expected = digestCsrfToken(input.token, input.audience, options.stateSecret);
      const received = Buffer.from(input.csrfToken);
      const expectedBuffer = Buffer.from(expected);
      return received.length === expectedBuffer.length && timingSafeEqual(received, expectedBuffer);
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
    [...returnPath].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new AuthenticationError("RETURN_PATH_INVALID");
  }
}

function digestState(state: string, secret: string, provider = "dingtalk") {
  return createHmac("sha256", secret)
    .update(`html-share:auth-state:v1:${provider}\0`)
    .update(state)
    .digest("base64url");
}

function digestToken(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

function digestCsrfToken(token: string, audience: SessionAudience, secret: string) {
  return createHmac("sha256", secret).update(`csrf:${audience}:${token}`).digest("base64url");
}

export type { AccessSessionRecord };
