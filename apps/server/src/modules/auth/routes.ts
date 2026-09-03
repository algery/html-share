import type { FastifyInstance, FastifyReply } from "fastify";

import {
  AuthenticationError,
  type AuthSessionService,
  type SessionAudience,
} from "@html-share/core";
import { DingTalkAuthorizationError, type DingTalkAuthorizationClient } from "@html-share/dingtalk";

import { clearSessionCookie, readSessionCookie, setSessionCookie } from "./cookies.js";
import { sendContentAuthorizationError } from "../content/error-pages.js";
import { sendContentLoginPage } from "../content/login-page.js";
import { readReturnPath, redirectToAudience } from "./return-state.js";

export interface AuthRouteOptions {
  appAuthUrl: string;
  appHost: string;
  appWebUrl: string;
  demoAuthUrl: string;
  demoHost: string;
  demoInAppClientId?: string;
  demoInAppCorpId?: string;
  demoWebUrl: string;
  dingtalk: DingTalkAuthorizationClient;
  sessions: AuthSessionService;
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions) {
  app.get("/auth/login", async (request, reply) => {
    const audience = getAudience(request.hostname, options);
    const returnPath = readReturnPath(readQuery(request.query, "return_path"));
    if (audience === null || returnPath === null) {
      return reply.code(400).send({ error: "invalid_auth_request" });
    }
    const { state } = await options.sessions.beginAuthorization({ audience, returnPath });
    return reply.redirect(
      options.dingtalk.createExternalAuthorizationUrl({
        callbackUrl: getCallbackUrl(audience, options),
        state,
      }),
    );
  });

  app.get("/auth/content-login", async (request, reply) => {
    if (getAudience(request.hostname, options) !== "demo") {
      return reply.code(404).send({ error: "not_found" });
    }
    const returnPath = readReturnPath(readQuery(request.query, "return_path"));
    if (returnPath === null) return reply.code(400).send({ error: "invalid_auth_request" });
    const { state } = await options.sessions.beginAuthorization({ audience: "demo", returnPath });
    return sendContentLoginPage(reply, {
      ...(options.demoInAppClientId === undefined ? {} : { clientId: options.demoInAppClientId }),
      ...(options.demoInAppCorpId === undefined ? {} : { corpId: options.demoInAppCorpId }),
      externalAuthorizationUrl: options.dingtalk.createExternalAuthorizationUrl({
        callbackUrl: getCallbackUrl("demo", options),
        state,
      }),
      state,
    });
  });

  app.post("/auth/internal/start", async (request, reply) => {
    const audience = getAudience(request.hostname, options);
    const returnPath = readReturnPath(readBodyValue(request.body, "returnPath"));
    if (audience === null || returnPath === null) {
      return reply.code(400).send({ error: "invalid_auth_request" });
    }
    const authorization = await options.sessions.beginAuthorization({ audience, returnPath });
    return { audience, state: authorization.state };
  });

  app.post("/auth/internal/complete", async (request, reply) => {
    const audience = getAudience(request.hostname, options);
    const code = readBodyValue(request.body, "code");
    const state = readBodyValue(request.body, "state");
    if (audience === null || code === undefined || state === undefined) {
      return reply.code(400).send({ error: "invalid_auth_request" });
    }
    return completeAuthorization({
      audience,
      code,
      contentLogin: audience === "demo",
      internal: true,
      options,
      reply,
      state,
    });
  });

  app.get("/auth/callback", async (request, reply) => {
    const audience = getAudience(request.hostname, options);
    const code = readQuery(request.query, "code");
    const state = readQuery(request.query, "state");
    if (audience === null || code === undefined || state === undefined) {
      return reply.code(400).send({ error: "invalid_auth_request" });
    }
    return completeAuthorization({
      audience,
      code,
      contentLogin: audience === "demo",
      internal: false,
      options,
      reply,
      state,
    });
  });

  app.get("/auth/current", async (request, reply) => {
    if (getAudience(request.hostname, options) !== "app") {
      return reply.code(404).send({ error: "not_found" });
    }
    const session = await options.sessions.getSession({
      audience: "app",
      token: readSessionCookie(request, "app"),
    });
    if (session === null) {
      return reply.code(401).send({ error: "authentication_required" });
    }
    return {
      expiresAt: session.expiresAt.toISOString(),
      user: {
        dingtalkUserId: session.user.dingtalkUserId,
        displayName: session.user.displayName,
      },
    };
  });

  app.post("/auth/logout", async (request, reply) => {
    const audience = getAudience(request.hostname, options);
    if (audience === null) {
      return reply.code(404).send({ error: "not_found" });
    }
    await options.sessions.logout({
      audience,
      token: readSessionCookie(request, audience),
    });
    clearSessionCookie(reply, audience);
    return reply.code(204).send();
  });

  app.get("/auth/content", async (request, reply) => {
    if (getAudience(request.hostname, options) !== "demo") {
      return reply.code(404).send({ error: "not_found" });
    }
    const session = await options.sessions.getSession({
      audience: "demo",
      token: readSessionCookie(request, "demo"),
    });
    if (session === null) {
      return reply.code(401).send({ error: "authorization_required", login: "/auth/login" });
    }
    return { status: "authorized" };
  });
}

async function completeAuthorization(input: {
  audience: SessionAudience;
  code: string;
  contentLogin?: boolean;
  internal: boolean;
  options: AuthRouteOptions;
  reply: FastifyReply;
  state: string;
}) {
  try {
    const identity = input.internal
      ? await input.options.dingtalk.exchangeInternalAuthorizationCode(input.code)
      : await input.options.dingtalk.exchangeExternalAuthorizationCode(input.code);
    const authorization = await input.options.sessions.finishAuthorization({
      audience: input.audience,
      identity,
      state: input.state,
    });
    setSessionCookie(input.reply, authorization);
    return input.reply.redirect(
      redirectToAudience({
        appWebUrl: input.options.appWebUrl,
        audience: input.audience,
        demoWebUrl: input.options.demoWebUrl,
        returnPath: authorization.returnPath,
      }),
    );
  } catch (error) {
    if (error instanceof AuthenticationError) {
      if (input.contentLogin)
        return sendContentAuthorizationError(input.reply, "AUTH_STATE_INVALID");
      return input.reply.code(400).send({ error: "invalid_auth_state" });
    }
    if (error instanceof DingTalkAuthorizationError) {
      if (input.contentLogin) {
        return sendContentAuthorizationError(
          input.reply,
          error.code === "AUTHORIZATION_DENIED"
            ? "ORGANIZATION_ACCESS_DENIED"
            : "IDENTITY_PROVIDER_UNAVAILABLE",
        );
      }
      return input.reply.code(error.code === "AUTHORIZATION_DENIED" ? 403 : 502).send({
        error:
          error.code === "AUTHORIZATION_DENIED"
            ? "organization_access_denied"
            : "identity_provider_unavailable",
      });
    }
    throw error;
  }
}

function getAudience(host: string, options: AuthRouteOptions): SessionAudience | null {
  if (host === options.appHost) return "app";
  if (host === options.demoHost) return "demo";
  return null;
}

function getCallbackUrl(audience: SessionAudience, options: AuthRouteOptions) {
  return new URL(
    "/auth/callback",
    audience === "app" ? options.appAuthUrl : options.demoAuthUrl,
  ).toString();
}

function readQuery(query: unknown, name: string) {
  if (typeof query !== "object" || query === null) return undefined;
  const value = (query as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

function readBodyValue(body: unknown, name: string) {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
