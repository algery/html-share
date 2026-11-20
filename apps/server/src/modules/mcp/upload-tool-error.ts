import type { UploadError } from "@html-share/core";

export function uploadToolError(error: unknown) {
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
    project_quota_exceeded: "已达到账号的 Demo 数量上限。可删除或覆盖已有 Demo。",
    project_upload_conflict: "该项目已有上传任务，请等待其完成或过期。",
    storage_quota_exceeded: "已达到 2 GB 存储配额；覆盖现有 Demo 不受此限制。",
    upload_rate_limited: "上传操作过于频繁，请稍后重试。",
    upload_protocol_unsupported: "ZIP 上传协议已停用，请升级 demo share Skill 后重试。",
    upload_not_found: "上传任务不存在或不属于当前用户。",
    upload_expired: "上传地址已过期，请重新创建上传任务。",
  };
  return messages[code] ?? "上传请求无效，请检查参数后重试。";
}
