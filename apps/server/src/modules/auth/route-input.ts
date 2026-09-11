import type { SessionAudience } from "@html-share/core";

import type { AuthRouteOptions } from "./routes.js";

export function getAudience(host: string, options: AuthRouteOptions): SessionAudience | null {
  if (host === options.appHost) return "app";
  if (host === options.demoHost) return "demo";
  return null;
}

export function getCallbackUrl(audience: SessionAudience, options: AuthRouteOptions) {
  return new URL(
    "/auth/callback",
    audience === "app" ? options.appAuthUrl : options.demoAuthUrl,
  ).toString();
}

export function readQuery(query: unknown, name: string) {
  if (typeof query !== "object" || query === null) return undefined;
  const value = (query as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

export function readBodyValue(body: unknown, name: string) {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
