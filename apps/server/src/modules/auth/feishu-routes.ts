import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { AccountLinkError, AuthenticationError } from "@html-share/core";
import { FeishuAuthorizationError, type FeishuAuthorizationClient } from "./feishu-client.js";
import type { AuthRouteOptions } from "./routes.js";
import { getAudience, readQuery } from "./route-input.js";
import { readReturnPath, redirectToAudience } from "./return-state.js";
import { setSessionCookie, usesSecureSessionCookie } from "./cookies.js";
import {
  clearFeishuState,
  expiredFeishuStateCookie,
  readFeishuState,
  setFeishuState,
} from "./feishu-state.js";
import {
  clearPasswordReturn,
  redirectPasswordFailure,
  setPasswordReturn,
  validPasswordReturn,
} from "./password-return.js";
import { sendContentNotFound } from "../content/error-pages.js";
import { usesSecurePasswordCookie } from "../content/password-cookies.js";

export interface FeishuLoginOptions {
  client: FeishuAuthorizationClient;
  stateSecret: string;
}

export function registerFeishuRoutes(app: FastifyInstance, options: AuthRouteOptions) {
  app.get("/auth/config", async (request, reply) => {
    if (getAudience(request.hostname, options) !== "app")
      return reply.code(404).send({ error: "not_found" });
    return reply
      .header("cache-control", "no-store")
      .send({ dingtalk: true, feishu: options.feishu !== undefined });
  });
  const feishu = options.feishu;
  if (feishu === undefined) return;

  app.addHook("onSend", async (request, reply, payload) => {
    if (reply.statusCode !== 429 || request.url.split("?", 1)[0] !== "/auth/feishu/callback")
      return payload;
    const audience = getAudience(request.hostname, options);
    if (audience === null) return payload;
    const state = readQuery(request.query, "state") ?? "";
    const authUrl = audience === "app" ? options.appAuthUrl : options.demoAuthUrl;
    if (/^[A-Za-z0-9_-]{43}$/.test(state))
      reply.header("set-cookie", expiredFeishuStateCookie(state, usesSecureSessionCookie(authUrl)));
    const target = new URL(
      audience === "app" ? "/login?status=error" : "/auth/content-login?status=error",
      audience === "app" ? options.appWebUrl : options.demoWebUrl,
    );
    reply.code(302).header("location", target.toString()).header("cache-control", "no-store");
    return "";
  });

  app.get("/auth/feishu/login", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const audience = getAudience(request.hostname, options);
    const returnPath = readReturnPath(readQuery(request.query, "return_path"));
    if (audience === null || returnPath === null)
      return reply.code(400).send({ error: "invalid_auth_request" });
    const passwordReturn = readQuery(request.query, "password_return");
    if (passwordReturn !== undefined) {
      const checked =
        audience === "demo" ? await validPasswordReturn(request, options, passwordReturn) : null;
      if (checked === false) return sendContentNotFound(reply);
      if (checked !== returnPath) return reply.code(400).send({ error: "invalid_auth_request" });
    }
    const { state } = await options.sessions.beginFeishuAuthorization({ audience, returnPath });
    const authUrl = audience === "app" ? options.appAuthUrl : options.demoAuthUrl;
    const codeVerifier = randomBytes(32).toString("base64url");
    setFeishuState(reply, {
      codeVerifier,
      state,
      audience,
      secret: feishu.stateSecret,
      secure: usesSecureSessionCookie(authUrl),
    });
    if (passwordReturn !== undefined)
      setPasswordReturn(reply, state, passwordReturn, usesSecurePasswordCookie(options.demoWebUrl));
    return reply.redirect(
      feishu.client.createAuthorizationUrl({
        callbackUrl: new URL("/auth/feishu/callback", authUrl).toString(),
        state,
        codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
      }),
    );
  });

  app.get("/auth/feishu/callback", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const audience = getAudience(request.hostname, options);
    if (audience === null) return reply.code(404).send({ error: "not_found" });
    const authUrl = audience === "app" ? options.appAuthUrl : options.demoAuthUrl;
    const secure = usesSecureSessionCookie(authUrl);
    const state = readQuery(request.query, "state") ?? "";
    const browserState = readFeishuState(request, {
      state,
      audience,
      secret: feishu.stateSecret,
      secure,
    });
    if (/^[A-Za-z0-9_-]{43}$/.test(state)) clearFeishuState(reply, state, secure);
    let status = "error";
    let retryPath = "/";
    try {
      if (browserState === null) throw new AuthenticationError("AUTH_STATE_INVALID");
      const authorization = await options.sessions.finishFeishuAuthorization({
        audience,
        state,
        resolveIdentity: async (validatedState) => {
          retryPath = validatedState.returnPath;
          const code = readQuery(request.query, "code");
          if (!code || code.length > 2048 || readQuery(request.query, "error") !== undefined)
            throw new FeishuAuthorizationError("AUTHORIZATION_DENIED");
          return feishu.client.exchangeAuthorizationCode({
            code,
            codeVerifier: browserState.codeVerifier,
            callbackUrl: new URL("/auth/feishu/callback", authUrl).toString(),
          });
        },
      });
      setSessionCookie(reply, { ...authorization, secure });
      if (audience === "demo")
        clearPasswordReturn(reply, state, usesSecurePasswordCookie(options.demoWebUrl));
      return reply.redirect(
        redirectToAudience({
          ...options,
          audience,
          returnPath: authorization.returnPath,
        }),
      );
    } catch (error) {
      if (error instanceof AccountLinkError)
        status = error.code === "ACCOUNT_LINK_CONFLICT" ? "account-conflict" : "denied";
      else if (error instanceof FeishuAuthorizationError && error.code === "AUTHORIZATION_DENIED")
        status = "denied";
      // Keep upstream bodies, credentials, and contact data out of logs and redirects.
      request.log.info(
        { trace_id: request.traceId, outcome: "failed", provider: "feishu", status },
        "authorization failed",
      );
      if (
        audience === "demo" &&
        browserState !== null &&
        (await redirectPasswordFailure(request, reply, options, state, "feishu"))
      )
        return reply;
      const target =
        audience === "app"
          ? new URL("/login", options.appWebUrl)
          : new URL("/auth/content-login", options.demoWebUrl);
      target.searchParams.set("status", status);
      if (audience === "demo") target.searchParams.set("return_path", retryPath);
      return reply.redirect(target.toString());
    }
  });
}
