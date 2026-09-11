import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { AuthenticationError } from "@html-share/core";

import {
  readSessionCookie,
  setSessionCookie,
  setSessionHandoffCheckedCookie,
  usesSecureSessionCookie,
} from "./cookies.js";
import { readQuery } from "./route-input.js";
import { readReturnPath, redirectToAudience } from "./return-state.js";
import type { AuthRouteOptions } from "./routes.js";

const START_PATH = "/auth/session-handoff/start";
const COMPLETE_PATH = "/auth/session-handoff/complete";

export function registerSessionHandoffRoutes(app: FastifyInstance, options: AuthRouteOptions) {
  app.get(START_PATH, async (request, reply) => {
    if (request.hostname !== options.appHost) {
      return reply.code(404).send({ error: "not_found" });
    }
    const returnPathQuery = readQuery(request.query, "return_path");
    const returnPath = readReturnPath(returnPathQuery);
    if (returnPathQuery === undefined || returnPath === null) {
      return reply.code(400).send({ error: "invalid_auth_request" });
    }
    let handoff;
    try {
      handoff = await options.sessions.beginSessionHandoff({
        returnPath,
        sourceAudience: "app",
        sourceToken: readSessionCookie(request, "app"),
        targetAudience: "demo",
      });
    } catch (error) {
      if (error instanceof AuthenticationError) {
        return reply
          .header("cache-control", "no-store")
          .code(400)
          .send({ error: "invalid_session_handoff" });
      }
      return sendSessionHandoffUnavailable(request, reply);
    }
    const completeUrl = new URL(COMPLETE_PATH, options.demoAuthUrl);
    if (handoff === null) completeUrl.searchParams.set("return_path", returnPath);
    else completeUrl.searchParams.set("ticket", handoff.ticket);
    return reply.header("cache-control", "no-store").redirect(completeUrl.toString());
  });

  app.get(COMPLETE_PATH, async (request, reply) => {
    if (request.hostname !== options.demoHost) {
      return reply.code(404).send({ error: "not_found" });
    }
    const ticket = readQuery(request.query, "ticket");
    if (ticket !== undefined) {
      try {
        const authorization = await options.sessions.finishSessionHandoff({
          targetAudience: "demo",
          ticket,
        });
        setSessionCookie(reply, {
          ...authorization,
          secure: usesSecureSessionCookie(options.demoAuthUrl),
        });
        return reply.header("cache-control", "no-store").redirect(
          redirectToAudience({
            appWebUrl: options.appWebUrl,
            audience: "demo",
            demoWebUrl: options.demoWebUrl,
            returnPath: authorization.returnPath,
          }),
        );
      } catch (error) {
        if (error instanceof AuthenticationError) {
          return reply
            .header("cache-control", "no-store")
            .code(400)
            .send({ error: "invalid_session_handoff" });
        }
        return sendSessionHandoffUnavailable(request, reply);
      }
    }

    const returnPathQuery = readQuery(request.query, "return_path");
    const returnPath = readReturnPath(returnPathQuery);
    if (returnPathQuery === undefined || returnPath === null) {
      return reply.code(400).send({ error: "invalid_auth_request" });
    }
    setSessionHandoffCheckedCookie(reply, usesSecureSessionCookie(options.demoAuthUrl));
    return reply.header("cache-control", "no-store").redirect(
      redirectToAudience({
        appWebUrl: options.appWebUrl,
        audience: "demo",
        demoWebUrl: options.demoWebUrl,
        returnPath,
      }),
    );
  });
}

export function createSessionHandoffStartUrl(appAuthUrl: string, returnPath: string) {
  const url = new URL(START_PATH, appAuthUrl);
  url.searchParams.set("return_path", returnPath);
  return url.toString();
}

function sendSessionHandoffUnavailable(request: FastifyRequest, reply: FastifyReply) {
  request.log.warn({ trace_id: request.traceId }, "session handoff unavailable");
  return reply
    .header("cache-control", "no-store")
    .code(503)
    .send({ error: "session_handoff_unavailable" });
}
