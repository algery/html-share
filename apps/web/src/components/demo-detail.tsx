"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { ProjectHomepageManager } from "./project-homepage-manager";
import { CopyCodeButton } from "./copy-code-button";
import { formatBytes, formatDate, type DemoSummary } from "./demo-list";
import { PasswordAccessManager, type ProjectAccessState } from "./password-access-manager";

interface DemoDetailResponse {
  csrfToken: string | null;
  project: Omit<DemoSummary, "projectPrefix"> & ProjectAccessState;
  files: { relativePath: string; size: number; url: string }[];
}

type DetailState =
  | { status: "loading" | "error" | "expired" | "missing" }
  | { status: "ready"; data: DemoDetailResponse };

const buttonClass = "button-secondary";
const linkClass =
  "text-sm font-semibold text-blue-700 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700";

export function DemoDetail({ apiUrl, projectId }: { apiUrl: string; projectId: string }) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${apiUrl}/api/projects/${encodeURIComponent(projectId)}`, {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setState({
            status:
              response.status === 401 ? "expired" : response.status === 404 ? "missing" : "error",
          });
          return;
        }
        const data = (await response.json()) as DemoDetailResponse;
        if (!controller.signal.aborted) setState({ status: "ready", data });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "error" });
      });
    return () => controller.abort();
  }, [apiUrl, projectId, attempt]);

  async function reloadHomepage() {
    const response = await fetch(`${apiUrl}/api/projects/${encodeURIComponent(projectId)}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("homepage_reload_failed");
    setState({ status: "ready", data: (await response.json()) as DemoDetailResponse });
  }

  function reload() {
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }

  function updateAccess(access: ProjectAccessState) {
    setState((current) =>
      current.status === "ready"
        ? {
            status: "ready",
            data: { ...current.data, project: { ...current.data.project, ...access } },
          }
        : current,
    );
  }

  return (
    <main className="workspace">
      <section className="min-w-0">
        <Link className={`inline-flex min-h-10 items-center ${linkClass}`} href="/demos">
          返回我的 Demo
        </Link>
        <div className="workspace-header mt-4">
          <div className="min-w-0 flex-1">
            <h1 className="page-title">
              {state.status === "ready" ? state.data.project.displayName : "项目文件"}
            </h1>
            <p className="page-description">查看已发布文件，复制链接即可分享。</p>
          </div>
          <button
            className={buttonClass}
            disabled={state.status === "loading"}
            onClick={reload}
            type="button"
          >
            重新加载
          </button>
        </div>
        {state.status === "loading" ? (
          <div aria-label="正在加载项目文件" className="mt-8 space-y-3" role="status">
            <div className="h-24 animate-pulse rounded-xl bg-slate-100" />
            <div className="h-48 animate-pulse rounded-xl bg-slate-100" />
          </div>
        ) : null}
        {state.status === "error" ? (
          <div
            className="mt-8 rounded-xl bg-rose-50 p-5 text-sm leading-6 text-rose-900"
            role="alert"
          >
            <h2 className="font-semibold">无法加载项目文件</h2>
            <p className="mt-1">
              请重试；若问题持续，请携带诊断编号 DEMO_DETAIL_REQUEST_FAILED 联系管理员。
            </p>
            <button className={`mt-4 ${buttonClass}`} onClick={reload} type="button">
              重试
            </button>
          </div>
        ) : null}
        {state.status === "expired" ? (
          <div
            className="mt-8 rounded-xl bg-amber-50 p-5 text-sm leading-6 text-amber-950"
            role="alert"
          >
            <h2 className="font-semibold">登录状态已过期</h2>
            <p className="mt-1">请重新完成钉钉登录后查看项目文件。</p>
            <Link className={`mt-4 inline-flex min-h-10 items-center ${linkClass}`} href="/login">
              前往登录
            </Link>
          </div>
        ) : null}
        {state.status === "missing" ? (
          <div
            className="mt-8 rounded-xl bg-slate-50 p-5 text-sm leading-6 text-slate-700"
            role="alert"
          >
            <h2 className="font-semibold">项目不存在或无法访问</h2>
            <p className="mt-1">
              该项目可能已删除，或不属于你。请返回“我的 Demo”查看可管理的项目。
            </p>
          </div>
        ) : null}
        {state.status === "ready" ? (
          <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <section className="min-w-0">
              <ProjectFiles data={state.data} />
            </section>
            <aside className="min-w-0 space-y-5">
              <ProjectHomepageManager
                apiUrl={apiUrl}
                projectId={projectId}
                csrfToken={state.data.csrfToken}
                homepage={state.data.project.homepage}
                files={state.data.files}
                onSaved={reloadHomepage}
              />
              <PasswordAccessManager
                access={state.data.project}
                apiUrl={apiUrl}
                csrfToken={state.data.csrfToken}
                onChanged={updateAccess}
                projectId={projectId}
              />
            </aside>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function ProjectFiles({ data }: { data: DemoDetailResponse }) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const visibleFiles =
    normalizedQuery.length === 0
      ? data.files
      : data.files.filter((file) => file.relativePath.toLowerCase().includes(normalizedQuery));

  return (
    <>
      <dl className="mb-6 grid grid-cols-2 gap-x-5 gap-y-3 border-b border-slate-200 pb-5 text-sm sm:grid-cols-4">
        {[
          ["项目标识", data.project.projectId],
          ["文件数", String(data.project.fileCount)],
          ["总大小", formatBytes(data.project.totalSize)],
          ["更新时间", formatDate(data.project.updatedAt)],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-slate-500">{label}</dt>
            <dd className="mt-1 break-all font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <section aria-labelledby="project-files-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="section-title" id="project-files-title">
              全部文件（{data.files.length}）
            </h2>
            {data.files.length > 0 ? (
              <p aria-live="polite" className="mt-1 text-xs text-slate-500">
                显示 {visibleFiles.length} / {data.files.length} 个文件
              </p>
            ) : null}
          </div>
          {data.files.length > 0 ? (
            <label className="w-full sm:w-72">
              <span className="sr-only">搜索文件名</span>
              <input
                autoComplete="off"
                className="field"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索文件名或目录"
                type="search"
                value={query}
              />
            </label>
          ) : null}
        </div>
        {data.files.length === 0 ? (
          <p className="mt-4 rounded-xl bg-slate-50 p-5 text-sm text-slate-600">
            当前项目暂无已发布文件。
          </p>
        ) : visibleFiles.length === 0 ? (
          <div className="mt-3 rounded-xl bg-slate-50 px-4 py-5 text-sm text-slate-600">
            <p>没有匹配的文件。</p>
            <button
              className="mt-2 min-h-10 md:min-h-9 font-semibold text-blue-700 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
              onClick={() => setQuery("")}
              type="button"
            >
              清空搜索
            </button>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
            {visibleFiles.map((file) => (
              <li className="min-w-0 px-3 py-2.5" key={file.url}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h3 className="min-w-0 break-all font-mono text-sm font-medium">
                    {file.relativePath}
                  </h3>
                  <span className="shrink-0 text-xs text-slate-500">{formatBytes(file.size)}</span>
                </div>
                <div className="mt-1 grid min-w-0 gap-1.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <a
                    className="flex min-h-10 min-w-0 items-center select-text break-all md:block md:min-h-0 font-mono text-xs leading-5 text-slate-600 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-blue-700"
                    href={file.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {file.url}
                  </a>
                  <CopyCodeButton
                    compact
                    {...(data.project.accessMode === "password" &&
                    data.project.passwordStatus !== "available"
                      ? { disabledReason: "请先重新生成密码" }
                      : {})}
                    failureValue={shareText(file.url, data.project)}
                    label="复制链接"
                    successMessage="已复制分享信息"
                    value={shareText(file.url, data.project)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function shareText(url: string, access: ProjectAccessState) {
  return access.accessMode === "password" && access.accessPassword !== undefined
    ? `链接：${url}\n密码：${access.accessPassword}`
    : url;
}
