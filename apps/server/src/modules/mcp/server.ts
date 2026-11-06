import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AuthenticatedMcpToken, UploadService } from "@html-share/core";
import type { ObjectStore } from "@html-share/storage";

import { registerUploadTools } from "./upload-tools.js";
import type { createUploadToolRateLimiter } from "./auth.js";

export function createHtmlShareMcpServer(input: {
  token: AuthenticatedMcpToken;
  demoWebUrl?: string;
  uploads?: UploadService;
  storage?: ObjectStore;
  traceId?: string;
  uploadRateLimiter?: ReturnType<typeof createUploadToolRateLimiter>;
}) {
  const server = new McpServer({ name: "html-share", version: "0.1.0" });
  server.registerTool(
    "check_connection",
    {
      description: "验证 demo share MCP 凭证并返回当前身份和到期时间。",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      const result = {
        expiresAt: input.token.expiresAt.toISOString(),
        user: input.token.user.displayName,
      };
      return {
        content: [{ text: JSON.stringify(result), type: "text" as const }],
        structuredContent: result,
      };
    },
  );
  if (input.uploads !== undefined && input.storage !== undefined) {
    registerUploadTools({
      server,
      ...(input.demoWebUrl === undefined ? {} : { demoWebUrl: input.demoWebUrl }),
      storage: input.storage,
      token: input.token,
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      ...(input.uploadRateLimiter === undefined ? {} : { rateLimiter: input.uploadRateLimiter }),
      uploads: input.uploads,
    });
  }
  return server;
}
