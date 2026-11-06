const ERROR_MESSAGES = {
  project_forbidden: "只能覆盖本人创建的项目。",
  project_quota_exceeded: "已达到项目数量上限。",
  project_upload_conflict: "该项目已有上传任务，请等待其完成或过期。",
  storage_quota_exceeded: "已达到存储配额上限。",
  upload_rate_limited: "上传操作过于频繁，请稍后重试。",
  upload_protocol_unsupported: "请升级 demo share Skill 和服务端后重试。",
  upload_not_found: "上传任务不存在、已超过保留窗口或不属于当前用户。",
  upload_expired: "上传任务已过期，不能取回此任务密码；重新生成密码须发布者明确要求。",
  invalid_upload_input: "上传参数无效，请检查参数及同一幂等任务的选项是否一致。",
};

class UploadRecoveryError extends Error {}

export async function withUploadRecovery(input, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof UploadRecoveryError) throw error;
    const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
    const identifiers = [
      ["project_id", input.projectId, /^[a-z0-9]{5}$/],
      ["upload_id", input.uploadId, uuid],
      ["client_request_id", input.clientRequestId, uuid],
    ]
      .filter(([, value, pattern]) => typeof value === "string" && pattern.test(value))
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    throw new UploadRecoveryError(
      (error instanceof Error ? error.message : "上传尚未确认完成。") +
        " 恢复同一任务时使用以下标识，不要自动重置密码。" +
        identifiers,
    );
  }
}

export async function mcpCall(request, url, token, id, name, args, timeoutMs = 10000) {
  const result = await mcpRpc(
    request,
    url,
    token,
    id,
    "tools/call",
    { arguments: args, name },
    timeoutMs,
  );
  const text = result?.content?.find((item) => item.type === "text")?.text;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("MCP 返回无效响应。");
  }
  if (result.isError) {
    const code =
      typeof value?.error === "string" && Object.hasOwn(ERROR_MESSAGES, value.error)
        ? value.error
        : undefined;
    const message = code ? ERROR_MESSAGES[code] : undefined;
    const error = new Error(
      message ? `MCP 请求失败（${code}）：${message}` : "MCP 请求失败，请检查服务端状态和参数。",
    );
    error.code = code;
    throw error;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("MCP 返回无效响应。");
  return value;
}

export async function mcpRpc(request, url, token, id, method, params, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining < 1) throw new Error("请求超时。");
    const controller = new globalThis.AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      let response;
      try {
        response = await request(url, {
          body: JSON.stringify({ id, jsonrpc: "2.0", method, params }),
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            authorization: "Bearer " + token,
            "content-type": "application/json",
            "mcp-protocol-version": "2025-11-25",
          },
          signal: controller.signal,
        });
      } catch {
        if (attempt === 0) continue;
        throw new Error(
          controller.signal.aborted ? "请求超时。" : "MCP 网络请求失败，请稍后重试。",
        );
      }
      if (!response.ok) {
        if (response.status >= 500 && attempt === 0) continue;
        throw new Error(`MCP 请求失败：HTTP ${Number(response.status) || 0}。`);
      }
      let body;
      try {
        body = await response.json();
      } catch {
        throw new Error("MCP 返回无效响应。");
      }
      if (body?.error || !body?.result) throw new Error("MCP 返回无效响应或服务端不支持当前调用。");
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("MCP 请求未完成。");
}

export async function requirePasswordCapabilities(request, url, token, options, timeoutMs) {
  if (Object.keys(options).length === 0) return;
  let result;
  try {
    result = await mcpRpc(request, url, token, 4, "tools/list", {}, timeoutMs);
  } catch {
    throw new Error("无法确认服务端密码选项支持，请检查连接或升级服务端；尚未创建上传任务。");
  }
  const properties = result.tools?.find((tool) => tool.name === "prepare_demo_upload")?.inputSchema
    ?.properties;
  if (Object.keys(options).some((key) => !Object.hasOwn(properties ?? {}, key))) {
    throw new Error(
      "服务端不支持所请求的密码选项，请升级 demo share 服务端后重试；尚未创建上传任务。",
    );
  }
}
