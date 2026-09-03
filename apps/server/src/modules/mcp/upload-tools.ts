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

const prepareSchema = z
  .object({
    action: z.enum(["create", "replace"]),
    archive_size: z
      .int()
      .min(1)
      .max(22 * 1024 * 1024),
    client_request_id: z.uuid(),
    display_name: z.string().min(1).max(80),
    file_count: z.int().min(1).max(500),
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
    total_size: z
      .int()
      .min(1)
      .max(20 * 1024 * 1024),
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
  token: AuthenticatedMcpToken;
  uploads: UploadService;
  storage: ObjectStore;
  rateLimiter?: ReturnType<typeof createUploadToolRateLimiter>;
}) {
  input.server.registerTool(
    "prepare_demo_upload",
    {
      description:
        "创建新 Demo 或本人项目覆盖上传任务，返回 5 分钟有效的 ZIP 直传地址。文件字节绝不能放入 MCP 参数。",
      inputSchema: prepareSchema,
    },
    async (args: z.infer<typeof prepareSchema>) => {
      try {
        if (
          input.rateLimiter !== undefined &&
          !input.rateLimiter.consumePrepare(input.token.user.id).allowed
        ) {
          return uploadToolError(new UploadError("UPLOAD_RATE_LIMITED"));
        }
        const task = await input.uploads.prepare({
          action: args.action,
          archiveSize: args.archive_size,
          clientRequestId: args.client_request_id,
          displayName: args.display_name,
          fileCount: args.file_count,
          manifestDigest: args.manifest_digest,
          owner: input.token.user,
          targetHtml: args.target_html,
          totalSize: args.total_size,
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
        const remainingSeconds = Math.floor((task.expiresAt.getTime() - Date.now()) / 1000);
        if (remainingSeconds < 1) throw new UploadError("UPLOAD_EXPIRED");
        const signed = await input.storage.createPresignedZipUpload({
          contentLength: task.archiveSize,
          expiresInSeconds: Math.min(UPLOAD_URL_TTL_MS / 1000, remainingSeconds),
          key: task.temporaryObjectKey,
        });
        const result = {
          expires_at: task.expiresAt.toISOString(),
          idempotent: task.idempotent,
          project_id: task.projectId,
          status: "prepared" as const,
          upload_headers: signed.headers,
          upload_id: task.uploadId,
          upload_url: signed.url,
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
    "complete_demo_upload",
    {
      description: "通知 HTML Share 开始服务端校验与原子发布。ZIP 内容仍不经过 MCP。",
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

function uploadToolError(error: unknown) {
  const code = isUploadError(error) ? error.code.toLowerCase() : "upload_request_failed";
  const result = { error: code, message: messageFor(code) };
  return {
    content: [{ text: JSON.stringify(result), type: "text" as const }],
    isError: true,
    structuredContent: result,
  };
}

function isUploadError(error: unknown): error is UploadError {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "UploadError" &&
    "code" in error
  );
}

function messageFor(code: string) {
  const messages: Record<string, string> = {
    project_forbidden: "只能覆盖本人创建的项目。",
    project_quota_exceeded: "已达到 100 个 Demo 上限；覆盖现有 Demo 不受此限制。",
    project_upload_conflict: "该项目已有上传任务，请等待其完成或过期。",
    storage_quota_exceeded: "已达到 2 GB 存储配额；覆盖现有 Demo 不受此限制。",
    upload_rate_limited: "上传操作过于频繁，请稍后重试。",
    upload_not_found: "上传任务不存在或不属于当前用户。",
    upload_expired: "上传地址已过期，请重新创建上传任务。",
  };
  return messages[code] ?? "上传请求无效，请检查参数后重试。";
}
