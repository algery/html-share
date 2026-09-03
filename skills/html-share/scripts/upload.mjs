import { createReadStream } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { fileURLToPath } from "node:url";

import { createClientRequestId, parseArguments, redact } from "./common.mjs";
import { cleanupArchive, packageDemo } from "./package.mjs";

const MAX_POLL_ATTEMPTS = 40;
const POLL_DELAY_MS = 250;
const MAX_MCP_ATTEMPTS = 2;
const REQUEST_TIMEOUT_MS = 10_000;

export async function publishDemo(input, dependencies = {}) {
  const request = dependencies.request ?? fetch;
  const sleep =
    dependencies.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const token = required(
    input.token ?? process.env["HTML_SHARE_MCP_TOKEN"],
    "HTML_SHARE_MCP_TOKEN",
  );
  const mcpUrl = required(input.mcpUrl, "mcpUrl");
  const demoUrl = required(input.demoUrl, "demoUrl");
  const requestTimeoutMs = input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const action =
    input.action === "replace" ? "replace" : input.action === "create" ? "create" : null;
  if (action === null) throw new Error("action 必须是 create 或 replace。");
  const projectId =
    action === "replace" ? extractProjectId(required(input.projectId, "projectId")) : undefined;
  const packaged = await packageDemo({ ...input, onPackage: input.onPackage });
  try {
    await mcpCall(request, mcpUrl, token, 1, "check_connection", {}, requestTimeoutMs);
    const clientRequestId = createClientRequestId(input.clientRequestId);
    let prepared = await prepare(request, mcpUrl, token, packaged, {
      action,
      clientRequestId,
      displayName: input.displayName ?? packaged.inspection.targetHtml,
      projectId,
      requestTimeoutMs,
    });
    if (prepared.status === "prepared") {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const uploaded = await uploadArchive(
          {
            archivePath: packaged.archivePath,
            headers: prepared.upload_headers,
            timeoutMs: requestTimeoutMs,
            uploadUrl: prepared.upload_url,
          },
          { request, uploadHostOverride: input.uploadHostOverride },
        );
        if (uploaded) break;
        prepared = await prepare(request, mcpUrl, token, packaged, {
          action,
          clientRequestId,
          displayName: input.displayName ?? packaged.inspection.targetHtml,
          projectId,
          requestTimeoutMs,
        });
        if (prepared.status !== "prepared") break;
      }
      if (prepared.status === "prepared")
        await mcpCall(
          request,
          mcpUrl,
          token,
          3,
          "complete_demo_upload",
          { upload_id: prepared.upload_id },
          requestTimeoutMs,
        );
    }
    const finished = await waitForTerminalStatus(
      request,
      mcpUrl,
      token,
      prepared.upload_id,
      sleep,
      requestTimeoutMs,
    );
    if (finished.status !== "completed")
      throw new Error("发布失败，服务端状态：" + finished.status + "。");
    return {
      projectId: finished.project_id,
      shareUrl: new URL(
        finished.project_id + "/" + packaged.inspection.targetHtml,
        demoUrl.endsWith("/") ? demoUrl : demoUrl + "/",
      ).toString(),
      uploadId: finished.upload_id,
    };
  } finally {
    await packaged.cleanup();
  }
}

async function prepare(request, mcpUrl, token, packaged, input) {
  const result = await mcpCall(
    request,
    mcpUrl,
    token,
    2,
    "prepare_demo_upload",
    {
      action: input.action,
      archive_size: packaged.archiveSize,
      client_request_id: input.clientRequestId,
      display_name: input.displayName,
      file_count: packaged.inspection.fileCount,
      manifest_digest: packaged.inspection.manifestDigest,
      ...(input.projectId === undefined ? {} : { project_id: input.projectId }),
      ...(packaged.inspection.risks.length === 0
        ? {}
        : { risk_ack_digest: packaged.inspection.riskAckDigest }),
      target_html: packaged.inspection.targetHtml,
      total_size: packaged.inspection.totalSize,
    },
    input.requestTimeoutMs,
  );
  if (typeof result.upload_id !== "string" || typeof result.project_id !== "string") {
    throw new Error("prepare_demo_upload 未返回上传任务。");
  }
  return result;
}

export async function uploadArchive(input, dependencies = {}) {
  const request = dependencies.request ?? fetch;
  const timeoutMs = input.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (typeof input.uploadUrl !== "string" || !isStringRecord(input.headers)) {
    throw new Error("服务端未返回可用的 ZIP 直传地址。");
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (dependencies.uploadHostOverride !== undefined) {
        if (await putWithHostOverride(input, dependencies.uploadHostOverride, timeoutMs))
          return true;
      } else {
        const response = await requestWithTimeout(
          request,
          input.uploadUrl,
          {
            body: createReadStream(input.archivePath),
            duplex: "half",
            headers: input.headers,
            method: "PUT",
          },
          timeoutMs,
        );
        if (response.ok) return true;
      }
    } catch {
      // Retry the same short-lived direct-upload address once before asking for a new task.
    }
  }
  return false;
}

function putWithHostOverride(input, hostname, timeoutMs) {
  const original = new URL(input.uploadUrl);
  const transport = original.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolveUpload, reject) => {
    const request = transport(
      {
        headers: { ...input.headers, host: original.host },
        hostname,
        method: "PUT",
        path: original.pathname + original.search,
        port: original.port,
        protocol: original.protocol,
      },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolveUpload((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300),
        );
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error("ZIP 直传超时。")));
    request.on("error", reject);
    createReadStream(input.archivePath).on("error", reject).pipe(request);
  });
}

async function waitForTerminalStatus(request, mcpUrl, token, uploadId, sleep, requestTimeoutMs) {
  const deadline = Date.now() + MAX_POLL_ATTEMPTS * POLL_DELAY_MS;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining < 1) break;
    let status;
    try {
      status = await mcpCall(
        request,
        mcpUrl,
        token,
        10 + attempt,
        "get_demo_upload_status",
        { upload_id: uploadId },
        Math.min(requestTimeoutMs, remaining),
      );
    } catch (error) {
      if (attempt + 1 >= MAX_POLL_ATTEMPTS) throw error;
      await sleep(POLL_DELAY_MS);
      continue;
    }
    if (
      status.status === "completed" ||
      status.status === "failed" ||
      status.status === "expired"
    ) {
      return status;
    }
    await sleep(POLL_DELAY_MS);
  }
  throw new Error("服务端未在 10 秒内完成发布，请稍后用原链接确认结果。");
}

async function mcpCall(request, mcpUrl, token, id, name, args, timeoutMs = REQUEST_TIMEOUT_MS) {
  for (let attempt = 0; attempt < MAX_MCP_ATTEMPTS; attempt += 1) {
    try {
      return await mcpCallOnce(request, mcpUrl, token, id, name, args, timeoutMs);
    } catch (error) {
      if (attempt + 1 >= MAX_MCP_ATTEMPTS || !isRetryableMcpError(error)) throw error;
    }
  }
  throw new Error("MCP " + name + " 请求失败。");
}

async function mcpCallOnce(request, mcpUrl, token, id, name, args, timeoutMs) {
  const response = await requestWithTimeout(
    request,
    mcpUrl,
    {
      body: JSON.stringify({
        id,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: args, name },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer " + token,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      method: "POST",
    },
    timeoutMs,
  );
  if (!response.ok) throw new Error("MCP " + name + " 请求失败：HTTP " + response.status + "。");
  const body = await response.json();
  const text = body.result?.content?.find((item) => item.type === "text")?.text;
  if (body.result?.isError || typeof text !== "string")
    throw new Error(redact(typeof text === "string" ? text : "MCP " + name + " 返回无效响应。"));
  return JSON.parse(text);
}

function isRetryableMcpError(error) {
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message : "";
  return message === "请求超时。" || /MCP .+ 请求失败：HTTP 5\d\d。/.test(message);
}

async function requestWithTimeout(request, url, init, timeoutMs) {
  const controller = new globalThis.AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("请求超时。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function extractProjectId(value) {
  if (/^[a-z0-9]{5}$/.test(value)) return value;
  const parsed = new URL(value);
  const match = /^\/([a-z0-9]{5})(?:\/|$)/.exec(parsed.pathname);
  if (match?.[1] === undefined) throw new Error("覆盖链接中未找到 5 位项目标识。");
  return match[1];
}

function isStringRecord(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(name + " 为必填项。");
  return value;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.archive_path !== undefined) {
    try {
      const uploaded = await uploadArchive(
        {
          archivePath: args.archive_path,
          headers: JSON.parse(required(args.upload_headers_json, "uploadHeadersJson")),
          uploadUrl: required(args.upload_url, "uploadUrl"),
        },
        { uploadHostOverride: process.env["HTML_SHARE_UPLOAD_HOST_OVERRIDE"] },
      );
      if (!uploaded) throw new Error("ZIP 直传失败，请重新创建上传任务后重试。");
      process.stdout.write(JSON.stringify({ status: "uploaded" }) + "\n");
    } finally {
      await cleanupArchive(args.archive_path, required(args.cleanup_token, "cleanupToken"));
    }
    return;
  }
  let cleanup;
  const interrupt = () => {
    void cleanup?.().finally(() => process.exit(130));
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const result = await publishDemo({
      action: args.action,
      clientRequestId: args.client_request_id,
      demoUrl: args.demo_url,
      displayName: args.display_name,
      mcpUrl: args.mcp_url,
      onPackage: (packaged) => {
        cleanup = packaged.cleanup;
      },
      projectId: args.project_id,
      publishDir: args.publish_dir,
      riskAckDigest: args.risk_ack_digest,
      targetHtml: args.target_html,
      uploadHostOverride: process.env["HTML_SHARE_UPLOAD_HOST_OVERRIDE"],
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(redact(error instanceof Error ? error.message : "发布未完成。") + "\n");
    process.exitCode = 1;
  });
}
