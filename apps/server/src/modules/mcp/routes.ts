import type { FastifyInstance, FastifyReply } from "fastify";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";

import type { McpTokenService, UploadService } from "@html-share/core";
import type { ObjectStore } from "@html-share/storage";

import {
  authenticateMcpRequest,
  createMcpRateLimiter,
  createUploadToolRateLimiter,
  hasTokenQueryParameter,
} from "./auth.js";
import { createHtmlShareMcpServer } from "./server.js";

export interface McpRouteOptions {
  appHost: string;
  demoWebUrl?: string;
  rateLimits?: {
    mcpPerMinute: number;
    uploadCompletePerMinute: number;
    uploadPreparePerMinute: number;
  };
  storage?: ObjectStore;
  tokenService: McpTokenService;
  uploads?: UploadService;
}

export function registerMcpRoutes(app: FastifyInstance, options: McpRouteOptions) {
  const rateLimiter = createMcpRateLimiter(
    options.rateLimits === undefined ? undefined : { maximum: options.rateLimits.mcpPerMinute },
  );
  const uploadRateLimiter = createUploadToolRateLimiter({
    ...(options.rateLimits === undefined
      ? {}
      : {
          completeMaximum: options.rateLimits.uploadCompletePerMinute,
          prepareMaximum: options.rateLimits.uploadPreparePerMinute,
        }),
  });

  app.post("/mcp", async (request, reply) => {
    if (request.hostname !== options.appHost) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (hasTokenQueryParameter(request.url)) {
      return unauthorized(reply);
    }
    const token = await authenticateMcpRequest({
      authorization: request.headers.authorization,
      tokenService: options.tokenService,
    });
    if (token === null) {
      return unauthorized(reply);
    }
    const limit = rateLimiter.consume({ ip: request.ip, token });
    if (!limit.allowed) {
      return reply
        .header("retry-after", String(limit.retryAfterSeconds))
        .code(429)
        .send({ error: "mcp_rate_limited", message: "请稍后重试。" });
    }

    const server = createHtmlShareMcpServer({
      token,
      ...(options.demoWebUrl === undefined ? {} : { demoWebUrl: options.demoWebUrl }),
      ...(options.storage === undefined ? {} : { storage: options.storage }),
      ...(options.uploads === undefined ? {} : { uploads: options.uploads }),
      traceId: request.traceId,
      uploadRateLimiter,
    });
    const transport = new NodeStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    reply.hijack();
    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
      if (reply.raw.statusCode >= 200 && reply.raw.statusCode < 300) {
        await options.tokenService.recordTokenUse({ tokenId: token.id });
      }
    } finally {
      await transport.close();
      await server.close();
    }
  });

  const methodNotAllowed = async (request: { hostname: string }, reply: FastifyReply) => {
    if (request.hostname !== options.appHost) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply
      .header("allow", "POST")
      .code(405)
      .send({ error: "mcp_method_not_allowed", message: "请使用 POST 连接 MCP 服务。" });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);
}

function unauthorized(reply: FastifyReply) {
  return reply
    .code(401)
    .header("www-authenticate", 'Bearer realm="html-share-mcp"')
    .send({ error: "mcp_token_invalid", message: "请在管理端创建新的 MCP Token 后重试。" });
}
