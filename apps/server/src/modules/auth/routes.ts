import { registerFeishuRoutes, type FeishuLoginOptions } from "./feishu-routes.js";
import { sendOrganizationLoginPage } from "../content/organization-login-page.js";
import { sendContentNotFound } from "../content/error-pages.js";
import {
  validPasswordReturn,
  setPasswordReturn,
  redirectPasswordFailure,
} from "./password-return.js";
import { completeAuthorization } from "./complete-authorization.js";
import type { FastifyInstance } from "fastify";

import { type AuthSessionService, type PasswordAccessService } from "@html-share/core";
import { type DingTalkAuthorizationClient } from "@html-share/dingtalk";

import { clearSessionCookie, readSessionCookie, usesSecureSessionCookie } from "./cookies.js";
import { logAuthorizationStep } from "./dingtalk-logging.js";
import { getAudience, getCallbackUrl, readBodyValue, readQuery } from "./route-input.js";
import { sendContentLoginPage } from "../content/login-page.js";
import { isTrustedWriteRequest } from "../projects/write-request.js";
import { readReturnPath } from "./return-state.js";
import { usesSecurePasswordCookie } from "../content/password-cookies.js";
import { registerSessionHandoffRoutes } from "./session-handoff.js";

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
  feishu?: FeishuLoginOptions;
  sessions: AuthSessionService;
  passwordAccess?: PasswordAccessService;
  passwordStateSecret?: string;
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions) {
  registerSessionHandoffRoutes(app, options);
  registerFeishuRoutes(app, options);
  app.get("/auth/login", async (request, reply) => {
    const audience = getAudience(request.hostname, options);
    const returnPath = readReturnPath(readQuery(request.query, "return_path"));
    if (audience === null || returnPath === null) {
      return reply.code(400).send({ error: "invalid_auth_request" });
    }
    const { state } = await options.sessions.beginAuthorization({ audience, returnPath });
    logAuthorizationStep(request.log, request.traceId, {
      audience,
      authFlow: "external",
      outcome: "succeeded",
      stage: "redirect_created",
    });
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
    const passwordReturn = readQuery(request.query, "password_return");
    if (passwordReturn !== undefined) {
      const checkedPath = await validPasswordReturn(request, options, passwordReturn);
      if (checkedPath === false) return sendContentNotFound(reply);
      if (checkedPath !== returnPath)
        return reply
          .header("cache-control", "no-store")
          .code(400)
          .send({ error: "invalid_auth_request" });
    }
    if (options.feishu !== undefined && readQuery(request.query, "provider") !== "dingtalk") {
      const params = new URLSearchParams({ return_path: returnPath });
      if (passwordReturn !== undefined) params.set("password_return", passwordReturn);
      const status = readQuery(request.query, "status");
      return sendOrganizationLoginPage(reply, {
        dingtalkUrl: `/auth/content-login?${params}&provider=dingtalk`,
        feishuUrl: `/auth/feishu/login?${params}`,
        ...(status === undefined ? {} : { status }),
      });
    }
    const { state } = await options.sessions.beginAuthorization({ audience: "demo", returnPath });
    if (passwordReturn !== undefined)
      setPasswordReturn(reply, state, passwordReturn, usesSecurePasswordCookie(options.demoWebUrl));
    logAuthorizationStep(request.log, request.traceId, {
      audience: "demo",
      authFlow: "external",
      outcome: "succeeded",
      stage: "content_login_created",
    });
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
    logAuthorizationStep(request.log, request.traceId, {
      audience,
      authFlow: "internal",
      outcome: "succeeded",
      stage: "internal_start_created",
    });
    return { audience, state: authorization.state };
  });

  app.post("/auth/internal/complete", async (request, reply) => {
    const audience = getAudience(request.hostname, options);
    const code = readBodyValue(request.body, "code");
    const state = readBodyValue(request.body, "state");
    if (
      code === undefined &&
      state !== undefined &&
      audience === "demo" &&
      (await redirectPasswordFailure(request, reply, options, state))
    )
      return reply;
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
      request,
      state,
    });
  });

  app.get("/auth/callback", async (request, reply) => {
    const audience = getAudience(request.hostname, options);
    const code = readQuery(request.query, "code");
    const state = readQuery(request.query, "state");
    if (
      code === undefined &&
      state !== undefined &&
      audience === "demo" &&
      (await redirectPasswordFailure(request, reply, options, state))
    )
      return reply;
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
      request,
      state,
    });
  });

  app.get("/auth/current", async (request, reply) => {
    if (getAudience(request.hostname, options) !== "app") {
      return reply.code(404).send({ error: "not_found" });
    }
    const token = readSessionCookie(request, "app");
    const session = await options.sessions.getSession({
      audience: "app",
      token,
    });
    if (session === null) {
      return reply.code(401).send({ error: "authentication_required" });
    }
    return {
      expiresAt: session.expiresAt.toISOString(),
      csrfToken: options.sessions.createCsrfToken({ audience: "app", token }),
      user: {
        dingtalkUserId: session.user.dingtalkUserId,
        displayName: session.user.displayName,
      },
    };
  });

  app.post("/auth/logout", async (request, reply) => {
    const audience = getAudience(request.hostname, options);
    if (audience !== "app") {
      return reply.code(404).send({ error: "not_found" });
    }
    if (!isTrustedWriteRequest(request, reply, options)) return;
    await options.sessions.logout({
      audience,
      token: readSessionCookie(request, "app"),
    });
    clearSessionCookie(reply, "app", usesSecureSessionCookie(options.appAuthUrl));
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
