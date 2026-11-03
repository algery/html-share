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
}: {
  apiUrl: string;
  projectId: string;
  csrfToken: string | null;
  homepage: DemoHomepage | undefined;
  files: { relativePath: string }[];
  onSaved: () => Promise<void>;
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
      await onSaved();
      setMessage(path ? "首页已保存。" : "已恢复自动识别。");
    } catch {
      setFailed(true);
      setMessage("网络异常，请重试或重新加载。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="mt-7 min-w-0 rounded-xl border border-slate-200 p-4"
      id="project-homepage"
      aria-labelledby="homepage-title"
    >
      <h2 className="font-semibold" id="homepage-title">
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
      <p className="mt-1 text-xs leading-5 text-slate-500">
        未指定时优先使用根目录 index.html，其次使用唯一 HTML
        文件。保存后，列表可直接打开或复制首页链接。
      </p>
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-3">
        <label className="min-w-0 flex-1 basis-60">
          <span className="sr-only">首页文件</span>
          <select
            aria-label="首页文件"
            className="min-h-10 w-full min-w-0 max-w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
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
          className="min-h-10 shrink-0 rounded-lg bg-blue-700 px-4 text-sm font-semibold text-white disabled:opacity-50 hover:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
          type="button"
          disabled={busy || (path !== "" && !candidates.some((file) => file.relativePath === path))}
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
    </section>
  );
}
