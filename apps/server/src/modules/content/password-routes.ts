import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { PasswordAccessService } from "@html-share/core";

import { readBodyValue, readQuery } from "../auth/route-input.js";
import { sendContentNotFound } from "./error-pages.js";
import { resolveDemoContentPath, type DemoContentPath } from "./path-resolver.js";
import {
  ensurePasswordBrowserCookie,
  readPasswordBrowserCookie,
  setPasswordAccessCookie,
  usesSecurePasswordCookie,
} from "./password-cookies.js";
import { applyPasswordResponseHeaders, sendPasswordPage } from "./password-page.js";
import { createPasswordRateLimiter } from "./password-rate-limit.js";
import {
  createPasswordState,
  readPasswordReturnPath,
  readPasswordState,
} from "./password-state.js";

export interface PasswordRouteOptions {
  demoHost: string;
  feishuEnabled?: boolean;
  demoWebUrl: string;
  passwordAccess: PasswordAccessService;
  stateSecret: string;
  now?: () => Date;
  rateLimits?: { ipPerMinute: number; ipProjectPerMinute: number; projectPerMinute: number };
  isAuthorized?: (request: FastifyRequest, path: DemoContentPath) => Promise<boolean>;
}

export function registerPasswordRoutes(app: FastifyInstance, options: PasswordRouteOptions) {
  const now = options.now ?? (() => new Date());
  const limiter = createPasswordRateLimiter({ now });
  const limits = options.rateLimits ?? {
    ipPerMinute: 60,
    ipProjectPerMinute: 30,
    projectPerMinute: 120,
  };
  const origin = new URL(options.demoWebUrl).origin;
  const secureCookie = usesSecurePasswordCookie(options.demoWebUrl);
  const expectedProtocol = secureCookie ? "https" : "http";
  const onRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    applyPasswordResponseHeaders(reply);
    if (request.hostname !== options.demoHost) return sendContentNotFound(reply);
    if (request.protocol !== expectedProtocol)
      return reply.code(403).send({
        error: secureCookie ? "请使用 HTTPS 安全链接访问" : "请使用配置的本地链接访问",
      });
  };
  // Parser and unexpected failures must never echo the submitted body or error message.
  const errorHandler = (_error: unknown, _request: FastifyRequest, reply: FastifyReply) => {
    applyPasswordResponseHeaders(reply);
    return reply.code(400).send({ error: "无法处理请求，请刷新页面后重试" });
  };

  app.get("/auth/password", { onRequest, errorHandler }, async (request, reply) => {
    const returnPath = readPasswordReturnPath(readQuery(request.query, "return_path"));
    const path = returnPath === null ? null : resolveDemoContentPath(returnPath);
    if (returnPath === null || path === null) return sendContentNotFound(reply);
    const target = await options.passwordAccess.getTarget(path);
    if (target === null) return sendContentNotFound(reply);
    if (await options.isAuthorized?.(request, path)) return reply.redirect(returnPath);
    if (target.accessMode !== "password") return reply.redirect(contentLoginUrl(returnPath));
    const state = createPasswordState({
      secret: options.stateSecret,
      browserToken: ensurePasswordBrowserCookie(request, reply, secureCookie),
      projectId: target.projectId,
      returnPath,
      now: now(),
    });
    return sendPasswordPage(reply, {
      state,
      returnPath,
      loginFailed: ["dingtalk", "feishu"].includes(readQuery(request.query, "error") ?? ""),
      feishuEnabled: options.feishuEnabled ?? false,
    });
  });

  app.post(
    "/auth/password/verify",
    {
      bodyLimit: 16_384,
      errorHandler,
      onRequest: async (request, reply) => {
        await onRequest(request, reply);
        if (reply.sent) return;
        if (request.protocol !== expectedProtocol || request.headers.origin !== origin)
          return reply.code(403).send({ error: "请从本站安全页面提交密码" });
        const ipLimit = limiter.consume(`ip:${request.ip}`, limits.ipPerMinute);
        if (!ipLimit.allowed) return limited(reply, ipLimit.retryAfterSeconds);
      },
    },
    async (request, reply) => {
      const state = readPasswordState({
        secret: options.stateSecret,
        browserToken: readPasswordBrowserCookie(request, secureCookie),
        state: readBodyValue(request.body, "state"),
        now: now(),
      });
      if (state === null) return reply.code(400).send({ error: "页面已过期或无效，请刷新后重试" });
      const path = resolveDemoContentPath(state.returnPath);
      if (path === null) return sendContentNotFound(reply);
      const target = await options.passwordAccess.getTarget(path);
      if (target === null || target.projectId !== state.projectId)
        return sendContentNotFound(reply);
      if (target.accessMode !== "password")
        return reply.send({ redirectUrl: contentLoginUrl(state.returnPath) });
      for (const [key, maximum] of [
        [`ip-project:${request.ip}:${target.projectId}`, limits.ipProjectPerMinute],
        [`project:${target.projectId}`, limits.projectPerMinute],
      ] as const) {
        const result = limiter.consume(key, maximum);
        if (!result.allowed) return limited(reply, result.retryAfterSeconds);
      }
      const password = readBodyValue(request.body, "password")?.trim();
      if (!password) return reply.code(400).send({ error: "请输入访问密码" });
      if (password.length > 256) return reply.code(401).send({ error: "密码错误，请重试" });
      try {
        const grant = await options.passwordAccess.verifyPassword({ ...path, password });
        if (grant === null) {
          const current = await options.passwordAccess.getTarget(path);
          if (current === null || current.projectId !== state.projectId)
            return sendContentNotFound(reply);
          if (current.accessMode !== "password")
            return reply.send({ redirectUrl: contentLoginUrl(state.returnPath) });
          return reply.code(401).send({ error: "密码错误，请重试" });
        }
        if (grant.projectId !== state.projectId) return sendContentNotFound(reply);
        setPasswordAccessCookie(reply, { ...grant, now: now() }, secureCookie);
        return reply.send({ redirectUrl: state.returnPath });
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === "Password hashing capacity exceeded" ||
            ("code" in error && error.code === "PASSWORD_HASH_CAPACITY_EXCEEDED"))
        )
          return limited(reply, 5);
        return reply.code(503).send({ error: "暂时无法验证，请稍后重试" });
      }
    },
  );
}

function contentLoginUrl(returnPath: string) {
  return `/auth/content-login?${new URLSearchParams({ return_path: returnPath })}`;
}

function limited(reply: FastifyReply, seconds: number) {
  return reply
    .header("retry-after", String(seconds))
    .code(429)
    .send({ error: "尝试次数过多，请稍后重试" });
}
