import type { FastifyReply, FastifyRequest } from "fastify";

import {
  consumeSessionHandoffCheckedCookie,
  readSessionCookie,
  usesSecureSessionCookie,
} from "../auth/cookies.js";
import { createSessionHandoffStartUrl } from "../auth/session-handoff.js";
import { readPasswordAccessCookie, usesSecurePasswordCookie } from "./password-cookies.js";
import { sendContentNotFound } from "./error-pages.js";
import { resolveDemoContentPath } from "./path-resolver.js";
import type { ContentRouteOptions } from "./routes.js";

export async function authorizeContent(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ContentRouteOptions,
) {
  const session = await options.sessions.getSession({
    audience: "demo",
    token: readSessionCookie(request, "demo"),
  });
  const returnPath = request.raw.url ?? request.url;
  const path = resolveDemoContentPath(returnPath);
  if (options.passwordAccess !== undefined) {
    if (path === null) {
      sendContentNotFound(reply);
      return null;
    }
    const token = readPasswordAccessCookie(
      request,
      path.projectKey,
      usesSecurePasswordCookie(options.demoWebUrl),
    );
    const authorized = await options.passwordAccess.authorize({
      ...path,
      ...(session === null ? {} : { tenantId: session.tenantId }),
      ...(token === undefined ? {} : { token }),
    });
    if (authorized !== null)
      return {
        ...authorized,
        principal:
          session !== null && authorized.principal.startsWith("organization:")
            ? `session:${session.id}`
            : authorized.principal,
      };
    const target = await options.passwordAccess.getTarget(path);
    if (target === null) {
      sendContentNotFound(reply);
      return null;
    }
    if (
      session === null &&
      !consumeSessionHandoffCheckedCookie(
        request,
        reply,
        usesSecureSessionCookie(options.demoAuthUrl),
      )
    ) {
      reply
        .header("cache-control", "no-store")
        .redirect(createSessionHandoffStartUrl(options.appAuthUrl, returnPath));
      return null;
    }
    if (session !== null && target.accessMode === "organization") {
      sendContentNotFound(reply);
      return null;
    }
    const login = target.accessMode === "password" ? "password" : "content-login";
    reply
      .header("cache-control", "no-store")
      .redirect(`/auth/${login}?return_path=${encodeURIComponent(returnPath)}`);
    return null;
  }
  if (session === null) {
    if (path === null) {
      sendContentNotFound(reply);
      return null;
    }
    if (
      !consumeSessionHandoffCheckedCookie(
        request,
        reply,
        usesSecureSessionCookie(options.demoAuthUrl),
      )
    ) {
      reply
        .header("cache-control", "no-store")
        .redirect(createSessionHandoffStartUrl(options.appAuthUrl, returnPath));
      return null;
    }
    reply
      .header("cache-control", "no-store")
      .redirect(`/auth/content-login?return_path=${encodeURIComponent(returnPath)}`);
    return null;
  }
  if (path === null || options.projects === undefined) {
    sendContentNotFound(reply);
    return null;
  }
  const file = await options.projects.findCurrentFile({ ...path, tenantId: session.tenantId });
  if (file === null) {
    sendContentNotFound(reply);
    return null;
  }
  return { file, principal: `user:${session.user.id}` };
}
