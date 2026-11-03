"use client";

import { CopyCodeButton, CopyValueError } from "./copy-code-button";

interface ProjectShareDetail {
  project: {
    accessMode: "organization" | "password";
    accessPassword?: string;
    passwordStatus?: string;
    homepage?: { url: string | null };
  };
}

export function CopyProjectShareButton({
  apiUrl,
  projectId,
  url,
}: {
  apiUrl: string;
  projectId: string;
  url: string;
}) {
  async function resolveShare() {
    const response = await fetch(`${apiUrl}/api/projects/${encodeURIComponent(projectId)}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok)
      throw new CopyValueError(
        response.status === 401
          ? "登录已过期，请重新登录。"
          : response.status === 404
            ? "项目已删除或无法访问，请刷新列表。"
            : "获取分享信息失败，请重试。",
      );
    const { project } = (await response.json()) as ProjectShareDetail;
    const currentUrl = project.homepage?.url;
    if (!currentUrl) throw new CopyValueError("首页已变化，请到详情重新设置首页。");
    if (project.accessMode === "organization") return currentUrl;
    if (project.passwordStatus !== "available" || !project.accessPassword)
      throw new CopyValueError("历史密码无法读取，请到详情重新生成密码。");
    return `链接：${currentUrl}\n密码：${project.accessPassword}`;
  }
  return (
    <CopyCodeButton
      compact
      label="复制链接和密码"
      value={url}
      resolveValue={resolveShare}
      successMessage="已复制分享信息"
    />
  );
}
