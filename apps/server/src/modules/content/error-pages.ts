import type { FastifyReply } from "fastify";

const NOT_FOUND_PAGE = "<!doctype html><title>Not found</title><h1>Not found</h1>";

const AUTHORIZATION_ERROR_PAGES = {
  AUTH_STATE_INVALID:
    "<!doctype html><title>无法完成钉钉授权</title><h1>无法完成钉钉授权，请重试</h1><p>诊断编号：AUTH_STATE_INVALID</p>",
  IDENTITY_PROVIDER_UNAVAILABLE:
    "<!doctype html><title>无法完成钉钉授权</title><h1>无法完成钉钉授权，请重试</h1><p>诊断编号：IDENTITY_PROVIDER_UNAVAILABLE</p>",
  ORGANIZATION_ACCESS_DENIED:
    "<!doctype html><title>无访问权限</title><h1>你不属于可访问组织</h1><p>诊断编号：ORGANIZATION_ACCESS_DENIED</p>",
} as const;

export function sendContentNotFound(reply: FastifyReply) {
  return reply
    .code(404)
    .header("cache-control", "no-store")
    .header("content-type", "text/html; charset=utf-8")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("x-robots-tag", "noindex")
    .send(NOT_FOUND_PAGE);
}

export function sendContentAuthorizationError(
  reply: FastifyReply,
  code: keyof typeof AUTHORIZATION_ERROR_PAGES,
) {
  return reply
    .code(code === "ORGANIZATION_ACCESS_DENIED" ? 403 : code === "AUTH_STATE_INVALID" ? 400 : 502)
    .header("cache-control", "no-store")
    .header("content-type", "text/html; charset=utf-8")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("x-robots-tag", "noindex")
    .send(AUTHORIZATION_ERROR_PAGES[code]);
}
