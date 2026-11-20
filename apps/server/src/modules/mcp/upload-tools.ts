import { publishedUploadFields } from "./upload-result.js";
import {
  UPLOAD_URL_TTL_MS,
  UploadError,
  type AuthenticatedMcpToken,
  type UploadService,
} from "@html-share/core";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ObjectStore } from "@html-share/storage";
import { z } from "zod";

import type { createUploadToolRateLimiter } from "./auth.js";
import { registerCoverUploadTool } from "./upload-cover-tool.js";
import { uploadToolError } from "./upload-tool-error.js";

const prepareSchema = z
  .object({
    action: z.enum(["create", "replace"]),
    access_mode: z.enum(["organization", "password"]).optional(),
    regenerate_password: z.boolean().optional(),
    archive_size: z.int().optional(),
    client_request_id: z.uuid(),
    display_name: z.string().min(1).max(80),
    file_count: z.int().optional(),
    files: z
      .array(
        z
          .object({
            content_md5: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
            mime_type: z.string().min(1).max(255),
            relative_path: z.string().min(1).max(1024),
            sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
            size: z
              .int()
              .min(0)
              .max(5 * 1024 * 1024),
          })
          .strict(),
      )
      .min(1)
      .max(500)
      .optional(),
    manifest_digest: z.string().regex(/^[a-fA-F0-9]{64}$/),
    project_id: z
      .string()
      .regex(/^[a-z0-9]{5}$/)
      .optional(),
    risk_ack_digest: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
    target_html: z.string().min(1).max(1024),
    total_size: z.int().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "create" && value.project_id !== undefined) {
      context.addIssue({
        code: "custom",
        message: "create 不接受 project_id",
        path: ["project_id"],
      });
    }
    if (value.action === "replace" && value.project_id === undefined) {
      context.addIssue({
        code: "custom",
        message: "replace 必须提供 project_id",
        path: ["project_id"],
      });
    }
  });

const completeSchema = z.object({ upload_id: z.uuid() }).strict();
const statusSchema = z.object({ upload_id: z.uuid() }).strict();

export function registerUploadTools(input: {
  server: McpServer;
  demoWebUrl?: string;
  token: AuthenticatedMcpToken;
  uploads: UploadService;
  storage: ObjectStore;
  traceId?: string;
  rateLimiter?: ReturnType<typeof createUploadToolRateLimiter>;
}) {
  input.server.registerTool(
    "prepare_demo_upload",
    {
      description:
        "创建新 Demo 或本人项目覆盖上传任务，返回逐文件 5 分钟精确 PutObject 地址。文件字节绝不能放入 MCP 参数。",
      inputSchema: prepareSchema,
    },
    async (args: z.infer<typeof prepareSchema>) => {
      try {
        if (
          args.archive_size !== undefined ||
          args.file_count !== undefined ||
          args.total_size !== undefined
        ) {
          throw new UploadError("UPLOAD_PROTOCOL_UNSUPPORTED");
        }
        if (args.files === undefined) throw new UploadError("INVALID_UPLOAD_INPUT");
        if (
          input.rateLimiter !== undefined &&
          !input.rateLimiter.consumePrepare(input.token.user.id).allowed
        ) {
          return uploadToolError(new UploadError("UPLOAD_RATE_LIMITED"));
        }
        const task = await input.uploads.prepare({
          action: args.action,
          ...(args.access_mode === undefined ? {} : { accessMode: args.access_mode }),
          ...(args.regenerate_password === undefined
            ? {}
            : { regeneratePassword: args.regenerate_password }),
          clientRequestId: args.client_request_id,
          displayName: args.display_name,
          files: args.files.map((file) => ({
            contentMd5: file.content_md5,
            mimeType: file.mime_type,
            relativePath: file.relative_path,
            sha256: file.sha256,
            size: file.size,
          })),
          manifestDigest: args.manifest_digest,
          owner: input.token.user,
          targetHtml: args.target_html,
          ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
          ...(args.project_id === undefined ? {} : { projectId: args.project_id }),
          ...(args.risk_ack_digest === undefined ? {} : { riskAckDigest: args.risk_ack_digest }),
        });
        if (task.status === "completed" || task.status === "processing") {
          const result = {
            expires_at: task.expiresAt.toISOString(),
            idempotent: true,
            project_id: task.projectId,
            status: task.status,
            upload_id: task.uploadId,
          };
          return {
            content: [{ text: JSON.stringify(result), type: "text" as const }],
            structuredContent: result,
          };
        }
        const remainingSeconds = Math.ceil((task.expiresAt.getTime() - Date.now()) / 1000);
        if (remainingSeconds < 1) throw new UploadError("UPLOAD_EXPIRED");
        const uploads = await Promise.all(
          task.files.map(async (file) => {
            const signed = await input.storage.createPresignedUpload({
              contentLength: file.size,
              contentMd5: file.contentMd5,
              contentType: file.mimeType,
              expiresInSeconds: Math.min(UPLOAD_URL_TTL_MS / 1000, remainingSeconds),
              key: file.storageKey,
            });
            return {
              relative_path: file.relativePath,
              upload_headers: signed.headers,
              upload_url: signed.url,
            };
          }),
        );
        const result = {
          ...(task.coverHomepage === undefined ? {} : { cover_homepage: task.coverHomepage }),
          expires_at: task.expiresAt.toISOString(),
          idempotent: task.idempotent,
          project_id: task.projectId,
          revision: task.revisionNumber,
          status: "prepared" as const,
          upload_id: task.uploadId,
          uploads,
        };
        return {
          content: [{ text: JSON.stringify(result), type: "text" as const }],
          structuredContent: result,
        };
      } catch (error) {
        return uploadToolError(error);
      }
    },
  );

  registerCoverUploadTool(input);

  input.server.registerTool(
    "complete_demo_upload",
    {
      description:
        "通知 demo share 仅通过 HeadObject 元数据核验并原子发布。文件正文不经过 MCP、应用服务器或 Worker。",
      inputSchema: completeSchema,
    },
    async (args: z.infer<typeof completeSchema>) => {
      try {
        if (
          input.rateLimiter !== undefined &&
          !input.rateLimiter.consumeComplete(args.upload_id).allowed
        ) {
          return uploadToolError(new UploadError("UPLOAD_RATE_LIMITED"));
        }
        const task = await input.uploads.complete({
          ownerUserId: input.token.user.id,
          uploadId: args.upload_id,
        });
        const result = {
          ...publishedUploadFields(task, input.demoWebUrl),
          expires_at: task.expiresAt.toISOString(),
          project_id: task.projectId,
          status: task.status,
          upload_id: task.uploadId,
        };
        return {
          content: [{ text: JSON.stringify(result), type: "text" as const }],
          structuredContent: result,
        };
      } catch (error) {
        return uploadToolError(error);
      }
    },
  );

  input.server.registerTool(
    "get_demo_upload_status",
    {
      description: "读取本人上传任务的最终状态，供本地 Skill 在完成发布后有界轮询。",
      inputSchema: statusSchema,
    },
    async (args: z.infer<typeof statusSchema>) => {
      try {
        const task = await input.uploads.status({
          ownerUserId: input.token.user.id,
          uploadId: args.upload_id,
        });
        const result = {
          ...publishedUploadFields(task, input.demoWebUrl),
          expires_at: task.expiresAt.toISOString(),
          project_id: task.projectId,
          status: task.status,
          upload_id: task.uploadId,
        };
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
