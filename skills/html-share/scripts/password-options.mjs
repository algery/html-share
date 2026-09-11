import { normalizeRelativePath } from "./common.mjs";

export function passwordOptions(input) {
  if (input.accessMode !== undefined && !["organization", "password"].includes(input.accessMode))
    throw new Error("access_mode 必须是 organization 或 password。");
  if (input.regeneratePassword !== undefined && typeof input.regeneratePassword !== "boolean")
    throw new Error("regenerate_password 必须是布尔值。");
  if (
    input.regeneratePassword &&
    (input.action !== "replace" || input.accessMode === "organization")
  )
    throw new Error("仅覆盖密码项目时可明确要求重新生成密码；不能与组织模式同时使用。");
  return {
    ...(input.accessMode === undefined ? {} : { access_mode: input.accessMode }),
    ...(input.regeneratePassword === undefined
      ? {}
      : { regenerate_password: input.regeneratePassword }),
  };
}

export function trustedDemoUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("demoUrl 必须是可信内容站点的完整地址。");
  }
  const local =
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("demoUrl 必须是可信内容站点根地址，不能含密码、查询参数或片段。");
  return url;
}

export function publicationResult(finished, input) {
  if (finished.status !== "completed") throw new Error("发布尚未完成，不能生成分享结果。");
  if (finished.project_id !== input.projectId || finished.upload_id !== input.uploadId)
    throw new Error("发布结果与原上传任务不一致，不能生成分享结果。");
  const target = normalizeRelativePath(input.targetHtml);
  const shareUrl = new URL(
    [input.projectId, ...target.split("/")].map(encodeURIComponent).join("/"),
    trustedDemoUrl(input.demoUrl),
  ).toString();
  const modern = finished.access_mode !== undefined;
  if (
    (!modern && (input.accessMode === "password" || input.regeneratePassword)) ||
    (modern && !["organization", "password"].includes(finished.access_mode))
  )
    throw new Error("发布结果缺少有效访问模式，请升级服务端或查询同一任务结果。");
  if (
    (modern && finished.target_url !== shareUrl) ||
    (!modern && finished.target_url !== undefined && finished.target_url !== shareUrl)
  )
    throw new Error("服务端目标链接与可信内容站点的原始准确路径不一致。");
  const accessMode = finished.access_mode ?? "organization";
  if (input.action === "create" && input.accessMode !== "password" && accessMode === "password")
    throw new Error("未明确要求密码访问，服务端却返回密码项目，不能生成分享结果。");
  if (
    (input.accessMode && input.accessMode !== accessMode) ||
    (input.regeneratePassword && accessMode !== "password")
  )
    throw new Error("服务端未按请求应用访问模式，不能生成分享结果。");
  const result = { projectId: input.projectId, shareUrl, uploadId: input.uploadId, accessMode };
  if (accessMode === "organization") {
    if (finished.access_password !== undefined || finished.password_status !== undefined)
      throw new Error("组织访问结果包含不一致的密码字段。");
    return result;
  }
  const status = finished.password_status;
  if (status === "generated") {
    if (!/^[A-HJ-NP-Za-kmnp-z2-9]{8}$/.test(finished.access_password ?? ""))
      throw new Error("发布结果缺少有效服务端密码，请查询同一任务结果。");
    return { ...result, passwordStatus: status, accessPassword: finished.access_password };
  }
  if (
    !["retained", "unavailable"].includes(status) ||
    finished.access_password !== undefined ||
    (status === "retained" && (input.action === "create" || input.regeneratePassword))
  )
    throw new Error("发布结果缺少有效密码状态，请查询同一任务结果。");
  return {
    ...result,
    passwordStatus: status,
    passwordMessage:
      status === "retained"
        ? "沿用原密码"
        : "密码结果已超过24小时取回窗口或已失效，无法再次取回。项目仍存在且开启密码访问时，可由发布者明确要求重新生成；项目已删除则需重新创建。",
  };
}
