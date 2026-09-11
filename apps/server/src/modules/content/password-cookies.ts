import { randomBytes } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import { isPasswordBrowserToken } from "./password-state.js";

const SECURE_COOKIE_PREFIX = "__Host-";

function cookiePrefix(secure: boolean) {
  return secure ? SECURE_COOKIE_PREFIX : "";
}

function passwordBrowserCookieName(secure: boolean) {
  return `${cookiePrefix(secure)}html_share_password_browser`;
}

function cookieOptions(secure: boolean) {
  return { httpOnly: true, secure, sameSite: "lax", path: "/" } as const;
}

export function passwordAccessCookieName(projectKey: string, secure = true) {
  if (!/^[a-z0-9]{5}$/.test(projectKey)) throw new Error("Invalid password project key");
  return `${cookiePrefix(secure)}html_share_password_${projectKey}`;
}

export function readPasswordBrowserCookie(request: FastifyRequest, secure: boolean) {
  const token = request.cookies[passwordBrowserCookieName(secure)];
  return isPasswordBrowserToken(token) ? token : undefined;
}

export function ensurePasswordBrowserCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  secure: boolean,
) {
  const token = readPasswordBrowserCookie(request, secure) ?? randomBytes(32).toString("base64url");
  reply.setCookie(passwordBrowserCookieName(secure), token, {
    ...cookieOptions(secure),
    maxAge: 8 * 60 * 60,
  });
  return token;
}

export function readPasswordAccessCookie(
  request: FastifyRequest,
  projectKey: string,
  secure: boolean,
) {
  return request.cookies[passwordAccessCookieName(projectKey, secure)];
}

export function setPasswordAccessCookie(
  reply: FastifyReply,
  input: {
    projectKey: string;
    token: string;
    expiresAt: Date;
    now?: Date;
  },
  secure: boolean,
) {
  reply.setCookie(passwordAccessCookieName(input.projectKey, secure), input.token, {
    ...cookieOptions(secure),
    expires: input.expiresAt,
    maxAge: Math.max(
      0,
      Math.floor((input.expiresAt.getTime() - (input.now ?? new Date()).getTime()) / 1000),
    ),
  });
}

export function usesSecurePasswordCookie(demoWebUrl: string) {
  const url = new URL(demoWebUrl);
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:" && isLocalDevelopmentHost(url.hostname)) return false;
  throw new Error(
    "Password access requires HTTPS unless DEMO_WEB_URL uses localhost or a loopback address",
  );
}

function isLocalDevelopmentHost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.startsWith("127.") ||
    hostname === "[::1]"
  );
}
