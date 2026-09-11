import type { UploadTaskSummary } from "@html-share/core";

export function publishedUploadFields(task: UploadTaskSummary, demoWebUrl?: string) {
  if (task.status !== "completed" || task.accessMode === undefined) return {};
  const path = task.targetHtml?.split("/").map(encodeURIComponent).join("/");
  const prefix =
    demoWebUrl === undefined
      ? undefined
      : new URL(`/${encodeURIComponent(task.projectId)}/`, demoWebUrl).toString();
  return {
    access_mode: task.accessMode,
    ...(prefix === undefined || path === undefined
      ? {}
      : {
          project_url: prefix,
          target_url: new URL(path, prefix).toString(),
        }),
    ...(task.accessPassword === undefined ? {} : { access_password: task.accessPassword }),
    ...(task.passwordStatus === undefined ? {} : { password_status: task.passwordStatus }),
    ...(task.passwordStatus === "retained" ? { password_message: "沿用原密码" } : {}),
    ...(task.passwordStatus === "unavailable"
      ? {
          password_message:
            "无法取回此任务密码。项目仍存在且开启密码访问时，可使用当前密码或明确要求重新生成；项目已删除则需重新创建。",
        }
      : {}),
  };
}
