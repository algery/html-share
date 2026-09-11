import { createClientRequestId, isMainModule, parseArguments, redact } from "./common.mjs";
import { uploadPreparedFiles } from "./direct-upload.mjs";
import { preflight } from "./preflight.mjs";
import { mcpCall, requirePasswordCapabilities, withUploadRecovery } from "./mcp-client.mjs";
import { passwordOptions, publicationResult, trustedDemoUrl } from "./password-options.mjs";

export { uploadPreparedFiles } from "./direct-upload.mjs";

const MAX_POLL_ATTEMPTS = 40;
const POLL_DELAY_MS = 250;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_UPLOAD_CONCURRENCY = 6;

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
  const demoUrl = trustedDemoUrl(required(input.demoUrl, "demoUrl")).toString();
  const requestTimeoutMs = input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const action =
    input.action === "replace" ? "replace" : input.action === "create" ? "create" : null;
  if (action === null) throw new Error("action 必须是 create 或 replace。");
  const projectId =
    action === "replace" ? extractProjectId(required(input.projectId, "projectId")) : undefined;
  const options = passwordOptions(input);
  const inspection = await inspectForUpload(input);
  await mcpCall(request, mcpUrl, token, 1, "check_connection", {}, requestTimeoutMs);
  await requirePasswordCapabilities(request, mcpUrl, token, options, requestTimeoutMs);
  const clientRequestId = createClientRequestId(input.clientRequestId);
  let prepared = await prepare(request, mcpUrl, token, inspection, {
    action,
    clientRequestId,
    displayName: input.displayName ?? inspection.targetHtml,
    projectId,
    requestTimeoutMs,
    options,
  });
  const firstTask = {
    projectId: prepared.project_id,
    uploadId: prepared.upload_id,
    clientRequestId,
  };
  return withUploadRecovery(firstTask, async () => {
    if (prepared.status === "prepared") {
      let uploaded = false;
      for (let attempt = 0; attempt < 2 && prepared.status === "prepared"; attempt += 1) {
        uploaded = await uploadPreparedFiles(
          {
            concurrency: input.uploadConcurrency ?? DEFAULT_UPLOAD_CONCURRENCY,
            inspection,
            timeoutMs: requestTimeoutMs,
            uploads: prepared.uploads,
          },
          { request, uploadHostOverride: input.uploadHostOverride },
        );
        if (uploaded) break;
        prepared = await prepare(request, mcpUrl, token, inspection, {
          action,
          clientRequestId,
          displayName: input.displayName ?? inspection.targetHtml,
          projectId,
          requestTimeoutMs,
          options,
        });
        if (
          prepared.project_id !== firstTask.projectId ||
          prepared.upload_id !== firstTask.uploadId
        )
          throw new Error("幂等重试返回了不同上传任务，已停止上传。");
      }
      if (!uploaded && prepared.status === "prepared") {
        throw new Error("逐文件直传失败，请使用同一 client_request_id 重试。");
      }
      if (prepared.status === "prepared") {
        try {
          await mcpCall(
            request,
            mcpUrl,
            token,
            3,
            "complete_demo_upload",
            { upload_id: prepared.upload_id },
            requestTimeoutMs,
          );
        } catch {
          throw new Error("完成请求尚未确认，请使用 --upload-id 和 --project-id 查询同一任务。");
        }
      }
    }
    return getPublishedDemoResult(
      {
        ...input,
        demoUrl,
        token,
        mcpUrl,
        clientRequestId,
        projectId: prepared.project_id,
        uploadId: prepared.upload_id,
        targetHtml: inspection.targetHtml,
      },
      { request, sleep },
    );
  });
}

async function inspectForUpload(input) {
  const inspection = await preflight(input);
  if (inspection.blocks.length > 0) throw new Error("预检存在硬阻断，不能上传。");
  if (inspection.risks.length > 0 && input.riskAckDigest !== inspection.riskAckDigest) {
    throw new Error("风险确认摘要不匹配；请重新确认当前目录的全部风险。");
  }
  if (!Array.isArray(inspection.sourceFiles)) throw new Error("预检文件快照无效，不能上传。");
  return inspection;
}

async function prepare(request, mcpUrl, token, inspection, input) {
  let result;
  try {
    result = await mcpCall(
      request,
      mcpUrl,
      token,
      2,
      "prepare_demo_upload",
      {
        action: input.action,
        client_request_id: input.clientRequestId,
        display_name: input.displayName,
        files: inspection.files,
        manifest_digest: inspection.manifestDigest,
        ...(input.projectId === undefined ? {} : { project_id: input.projectId }),
        ...(inspection.risks.length === 0 ? {} : { risk_ack_digest: inspection.riskAckDigest }),
        target_html: inspection.targetHtml,
        ...input.options,
      },
      input.requestTimeoutMs,
    );
  } catch (error) {
    throw new Error(
      error.message +
        " 请保持相同发布参数及 client_request_id 重试，不要自动重置密码。client_request_id=" +
        input.clientRequestId,
    );
  }
  if (
    !validUploadId(result.upload_id) ||
    !/^[a-z0-9]{5}$/.test(result.project_id ?? "") ||
    (input.projectId !== undefined && result.project_id !== input.projectId) ||
    !["prepared", "processing", "completed"].includes(result.status)
  ) {
    throw new Error("prepare_demo_upload 未返回上传任务。");
  }
  if (result.status === "prepared" && !Array.isArray(result.uploads)) {
    throw new Error("prepare_demo_upload 未返回逐文件上传地址。");
  }
  return result;
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
      if (error?.code) throw error;
      if (attempt + 1 >= MAX_POLL_ATTEMPTS) break;
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
  throw new Error("服务端尚未确认发布完成；请用 --upload-id 和 --project-id 查询同一任务。");
}

export async function getPublishedDemoResult(input, dependencies = {}) {
  const request = dependencies.request ?? fetch;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const token = required(
    input.token ?? process.env["HTML_SHARE_MCP_TOKEN"],
    "HTML_SHARE_MCP_TOKEN",
  );
  const projectId = extractProjectId(required(input.projectId, "projectId"));
  if (!validUploadId(input.uploadId)) throw new Error("upload_id 必须是有效上传任务 UUID。");
  if (input.clientRequestId !== undefined) createClientRequestId(input.clientRequestId);
  trustedDemoUrl(input.demoUrl);
  return withUploadRecovery({ ...input, projectId }, async () => {
    const finished = await waitForTerminalStatus(
      request,
      required(input.mcpUrl, "mcpUrl"),
      token,
      input.uploadId,
      sleep,
      input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    );
    if (finished.status !== "completed")
      throw new Error(
        finished.status === "expired"
          ? "上传任务已过期，无法取回此任务密码；重新生成须发布者明确要求。"
          : "发布失败，未生成分享结果。",
      );
    return publicationResult(finished, { ...input, projectId });
  });
}

function validUploadId(value) {
  return typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
}

export function extractProjectId(value) {
  if (/^[a-z0-9]{5}$/.test(value)) return value;
  const parsed = new URL(value);
  const match = /^\/([a-z0-9]{5})(?:\/|$)/.exec(parsed.pathname);
  if (match?.[1] === undefined) throw new Error("覆盖链接中未找到 5 位项目标识。");
  return match[1];
}

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(name + " 为必填项。");
  return value;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const allowed = new Set([
    "access_mode",
    "regenerate_password",
    "upload_id",
    "action",
    "client_request_id",
    "demo_url",
    "display_name",
    "mcp_url",
    "project_id",
    "publish_dir",
    "risk_ack_digest",
    "target_html",
  ]);
  if (Object.keys(args).some((key) => !allowed.has(key)))
    throw new Error("存在不支持的参数，请检查参数名。");
  const run = args.upload_id === undefined ? publishDemo : getPublishedDemoResult;
  const result = await run({
    accessMode: args.access_mode,
    regeneratePassword: args.regenerate_password,
    uploadId: args.upload_id,
    action: args.action,
    clientRequestId: args.client_request_id,
    demoUrl: args.demo_url,
    displayName: args.display_name,
    mcpUrl: args.mcp_url,
    projectId: args.project_id,
    publishDir: args.publish_dir,
    riskAckDigest: args.risk_ack_digest,
    targetHtml: args.target_html,
    uploadHostOverride: process.env["HTML_SHARE_UPLOAD_HOST_OVERRIDE"],
  });
  process.stdout.write(JSON.stringify(result) + "\n");
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(redact(error instanceof Error ? error.message : "发布未完成。") + "\n");
    process.exitCode = 1;
  });
}
