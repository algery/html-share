"use client";

import { useState } from "react";
import type { DemoHomepage } from "./demo-homepage-link";

export function ProjectHomepageManager({
  apiUrl,
  projectId,
  csrfToken,
  homepage,
  files,
  onSaved,
  onSavingChange,
}: {
  apiUrl: string;
  projectId: string;
  csrfToken: string | null;
  homepage: DemoHomepage | undefined;
  files: { relativePath: string }[];
  onSaved: () => Promise<void>;
  onSavingChange: (saving: boolean) => void;
}) {
  const candidates = files.filter((file) => /\.html?$/i.test(file.relativePath));
  const [path, setPath] = useState(homepage?.configuredPath ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  async function save() {
    if (busy) return;
    if (!csrfToken) {
      setFailed(true);
      setMessage("安全校验已过期，请重新加载或登录。");
      return;
    }
    setBusy(true);
    onSavingChange(true);
    setFailed(false);
    setMessage(null);
    try {
      const response = await fetch(`${apiUrl}/api/projects/${projectId}/homepage`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json", "x-html-share-csrf": csrfToken },
        body: JSON.stringify({ relativePath: path || null }),
      });
      if (!response.ok) {
        setFailed(true);
        setMessage(
          response.status === 409
            ? "文件集合已变化，请重新加载后选择。"
            : response.status === 401 || response.status === 403
              ? "登录或安全校验已过期，请重新加载或登录。"
              : "首页保存失败，请重试或重新加载。",
        );
        return;
      }
      try {
        await onSaved();
        setMessage(path ? "首页已保存。" : "已恢复自动识别。");
      } catch {
        setFailed(true);
        setMessage("首页已保存，请重新加载后访问。");
      }
    } catch {
      setFailed(true);
      setMessage("网络异常，请重试或重新加载。");
    } finally {
      setBusy(false);
      onSavingChange(false);
    }
  }
  return (
    <section
      aria-labelledby="homepage-title"
      className="project-setting-row scroll-mt-5"
      id="project-homepage"
      tabIndex={-1}
    >
      <div className="min-w-0">
        <h2 className="section-title" id="homepage-title">
          项目首页
        </h2>
        <p className="mt-2 break-all text-sm text-slate-600">
          {homepage?.source === "missing"
            ? "原指定首页已被移除，请重新设置。"
            : homepage?.path
              ? `当前首页：${homepage.path}（${homepage.source === "manual" ? "手动指定" : "自动识别"}）`
              : candidates.length
                ? "有多个 HTML 文件，请选择分享时打开的首页。"
                : "暂无可用的 HTML 文件。"}
        </p>
      </div>
      <div className="min-w-0">
        <p className="text-xs leading-5 text-slate-500">
          自动识别优先使用根目录 index.html，其次使用唯一 HTML 文件。
        </p>
        <div className="mt-3 flex max-w-2xl min-w-0 flex-wrap items-center gap-3">
          <label className="min-w-0 flex-1 basis-60">
            <span className="sr-only">首页文件</span>
            <select
              aria-label="首页文件"
              className="field scroll-mt-5"
              id="project-homepage-file"
              value={path}
              disabled={busy}
              onChange={(event) => {
                setPath(event.target.value);
                setMessage(null);
              }}
            >
              <option value="">自动识别（清除手动指定）</option>
              {homepage?.source === "missing" && homepage.configuredPath ? (
                <option value={homepage.configuredPath} disabled>
                  已移除：{homepage.configuredPath}
                </option>
              ) : null}
              {candidates.map((file) => (
                <option key={file.relativePath} value={file.relativePath}>
                  {file.relativePath}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button-secondary"
            type="button"
            disabled={
              busy || (path !== "" && !candidates.some((file) => file.relativePath === path))
            }
            onClick={() => void save()}
          >
            {busy ? "正在保存…" : "保存首页"}
          </button>
        </div>
        {message ? (
          <p
            className={`mt-2 text-sm ${failed ? "text-rose-700" : "text-slate-600"}`}
            role={failed ? "alert" : "status"}
          >
            {message}
          </p>
        ) : null}
      </div>
    </section>
  );
}
