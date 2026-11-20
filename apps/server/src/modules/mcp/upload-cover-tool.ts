import {
  DEMO_COVER_MIME,
  MAX_DEMO_COVER_BYTES,
  UPLOAD_URL_TTL_MS,
  UploadError,
  type AuthenticatedMcpToken,
  type UploadService,
} from "@html-share/core";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ObjectStore } from "@html-share/storage";
import { z } from "zod";

import type { createUploadToolRateLimiter } from "./auth.js";
import { uploadToolError } from "./upload-tool-error.js";

const coverSchema = z
  .object({
    upload_id: z.uuid(),
    homepage_path: z.string().min(1).max(1024),
    size: z.int().min(1).max(MAX_DEMO_COVER_BYTES),
    content_md5: z.string().regex(/^[A-Za-z0-9+/]{21}[AQgw]==$/),
  })
  .strict();

export function registerCoverUploadTool(input: {
  server: McpServer;
  token: AuthenticatedMcpToken;
  uploads: UploadService;
  storage: ObjectStore;
  rateLimiter?: ReturnType<typeof createUploadToolRateLimiter>;
}) {
  input.server.registerTool(
    "prepare_demo_cover",
    {
      description:
        "为本人的待上传任务签发可选首页 JPEG 的精确直传地址。图片字节绝不能放入 MCP 参数。",
      inputSchema: coverSchema,
    },
    async (args: z.infer<typeof coverSchema>) => {
      try {
        if (
          input.rateLimiter !== undefined &&
          !input.rateLimiter.consumeCover(input.token.user.id).allowed
        )
          throw new UploadError("UPLOAD_RATE_LIMITED");
        const cover = await input.uploads.prepareCover({
          contentMd5: args.content_md5,
          homepagePath: args.homepage_path,
          ownerUserId: input.token.user.id,
          size: args.size,
          uploadId: args.upload_id,
        });
        const remainingSeconds = Math.floor((cover.expiresAt.getTime() - Date.now()) / 1000);
        if (remainingSeconds < 1) throw new UploadError("UPLOAD_EXPIRED");
        const signed = await input.storage.createPresignedUpload({
          contentLength: cover.size,
          contentMd5: cover.contentMd5,
          contentType: DEMO_COVER_MIME,
          expiresInSeconds: Math.min(UPLOAD_URL_TTL_MS / 1000, remainingSeconds),
          key: cover.storageKey,
        });
        const result = { upload_headers: signed.headers, upload_url: signed.url };
        return {
          content: [{ text: JSON.stringify(result), type: "text" as const }],
          structuredContent: result,
        };
      } catch (error) {
        return uploadToolError(error);
      }
    },
  );
}
