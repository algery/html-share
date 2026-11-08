import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  McpTokenError,
  toTokenResponse,
  type AuthSessionService,
  type McpTokenService,
} from "@html-share/core";

import { readSessionCookie } from "../auth/cookies.js";
import { isTrustedWriteRequest } from "../projects/write-request.js";

export interface TokenRouteOptions {
  appHost: string;
  appWebUrl: string;
  sessions: AuthSessionService;
  tokens: McpTokenService;
}

export function registerTokenRoutes(app: FastifyInstance, options: TokenRouteOptions) {
  app.get("/api/tokens", async (request, reply) => {
    const session = await requireAppSession(request, reply, options);
    if (session === null) return;
    const tokens = await options.tokens.listTokens({ userId: session.user.id });
    return { tokens: tokens.map(toTokenResponse) };
  });

  app.post("/api/tokens", async (request, reply) => {
    if (!isTrustedWriteRequest(request, reply, options)) return;
    const session = await requireAppSession(request, reply, options);
    if (session === null) return;
    const name = readField(request.body, "name");
    if (typeof name !== "string") {
      return reply.code(400).send({ error: "invalid_token_name" });
    }
    try {
      const created = await options.tokens.createToken({
        name,
        expiresInDays: readField(request.body, "expiresInDays"),
        user: session.user,
      });
      reply.header("cache-control", "no-store");
      return reply
        .code(201)
        .send({ token: toTokenResponse(created.summary), value: created.token });
    } catch (error) {
      if (error instanceof McpTokenError) {
        return reply.code(400).send({
          error:
            error.code === "TOKEN_VALIDITY_INVALID"
              ? "invalid_token_validity"
              : "invalid_token_name",
        });
      }
      throw error;
    }
  });

  app.post("/api/tokens/:tokenId/revoke", async (request, reply) => {
    if (!isTrustedWriteRequest(request, reply, options)) return;
    const session = await requireAppSession(request, reply, options);
    if (session === null) return;
    const tokenId = readPathParameter(request, "tokenId");
    if (tokenId === undefined) return reply.code(404).send({ error: "not_found" });
    const revoked = await options.tokens.revokeToken({ tokenId, userId: session.user.id });
    return revoked ? reply.code(204).send() : reply.code(404).send({ error: "not_found" });
  });
}

async function requireAppSession(
  request: FastifyRequest,
  reply: FastifyReply,
  options: TokenRouteOptions,
) {
  if (request.hostname !== options.appHost) {
    reply.code(404).send({ error: "not_found" });
    return null;
  }
  const session = await options.sessions.getSession({
    audience: "app",
    token: readSessionCookie(request, "app"),
  });
  if (session === null) {
    reply.code(401).send({ error: "authentication_required" });
    return null;
  }
  return session;
}

function readField(body: unknown, key: string) {
  if (typeof body !== "object" || body === null) return undefined;
  return (body as Record<string, unknown>)[key];
}

function readPathParameter(request: FastifyRequest, key: string) {
  const value = (request.params as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
