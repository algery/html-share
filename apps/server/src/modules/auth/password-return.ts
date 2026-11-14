import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthRouteOptions } from "./routes.js";
import { readPasswordState } from "../content/password-state.js";
import {
  readPasswordBrowserCookie,
  usesSecurePasswordCookie,
} from "../content/password-cookies.js";
import { resolveDemoContentPath } from "../content/path-resolver.js";
import { sendContentNotFound } from "../content/error-pages.js";

function cookieName(state: string, secure: boolean) {
  const prefix = secure ? "__Host-" : "";
  return `${prefix}html_share_password_return_${createHash("sha256").update(state).digest("hex").slice(0, 24)}`;
}

export async function validPasswordReturn(
  request: FastifyRequest,
  options: AuthRouteOptions,
  state: unknown,
) {
  if (options.passwordStateSecret === undefined || options.passwordAccess === undefined)
    return null;
  const secureCookie = usesSecurePasswordCookie(options.demoWebUrl);
  const decoded = readPasswordState({
    secret: options.passwordStateSecret,
    browserToken: readPasswordBrowserCookie(request, secureCookie),
    state,
  });
  if (decoded === null) return null;
  const path = resolveDemoContentPath(decoded.returnPath);
  if (path === null) return null;
  const target = await options.passwordAccess.getTarget(path);
  return target?.projectId === decoded.projectId ? decoded.returnPath : false;
}

export function setPasswordReturn(
  reply: FastifyReply,
  authState: string,
  passwordState: string,
  secure: boolean,
) {
  reply.setCookie(cookieName(authState, secure), passwordState, {
    path: "/",
    httpOnly: true,
    secure,
    sameSite: "lax",
    maxAge: 600,
  });
}

export function clearPasswordReturn(reply: FastifyReply, authState: string, secure: boolean) {
  reply.clearCookie(cookieName(authState, secure), {
    path: "/",
    httpOnly: true,
    secure,
    sameSite: "lax",
  });
}

export async function redirectPasswordFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  options: AuthRouteOptions,
  authState: string,
  provider: "dingtalk" | "feishu" = "dingtalk",
) {
  if (request.hostname !== options.demoHost) return false;
  const secureCookie = usesSecurePasswordCookie(options.demoWebUrl);
  const stored = request.cookies[cookieName(authState, secureCookie)];
  if (stored === undefined) return false;
  clearPasswordReturn(reply, authState, secureCookie);
  if (options.passwordStateSecret === undefined || options.passwordAccess === undefined)
    return false;
  const decoded = readPasswordState({
    secret: options.passwordStateSecret,
    browserToken: readPasswordBrowserCookie(request, secureCookie),
    state: stored,
  });
  if (decoded === null) return false;
  const path = resolveDemoContentPath(decoded.returnPath);
  const target = path === null ? null : await options.passwordAccess.getTarget(path);
  if (target === null || target.projectId !== decoded.projectId) {
    sendContentNotFound(reply);
    return true;
  }
  const returnPath = decoded.returnPath;
  reply
    .header("cache-control", "no-store")
    .redirect(`/auth/password?return_path=${encodeURIComponent(returnPath)}&error=${provider}`);
  return true;
}
