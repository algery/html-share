"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

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

const buttonClass =
  "min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700";
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
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
      <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-10">
        <Link className={linkClass} href="/demos">
          返回我的 Demo
        </Link>
        <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-blue-700">Demo 详情</p>
            <h1 className="mt-3 break-all text-3xl font-semibold tracking-tight">
              {state.status === "ready" ? state.data.project.displayName : "项目文件"}
            </h1>
            <p className="mt-4 text-sm leading-6 text-slate-600">
              查看全部已发布文件，复制链接即可分享给组织成员。
            </p>
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
          <>
            <PasswordAccessManager
              access={state.data.project}
              apiUrl={apiUrl}
              csrfToken={state.data.csrfToken}
              onChanged={updateAccess}
              projectId={projectId}
            />
            <ProjectFiles data={state.data} />
          </>
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
      <dl className="mt-8 grid grid-cols-2 gap-4 rounded-xl bg-slate-50 p-4 text-sm sm:grid-cols-4">
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
      <section className="mt-7" aria-labelledby="project-files-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold" id="project-files-title">
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
                className="min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm focus:outline-2 focus:outline-offset-2 focus:outline-blue-700"
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
              className="mt-2 min-h-9 font-semibold text-blue-700 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
              onClick={() => setQuery("")}
              type="button"
            >
              清空搜索
            </button>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-slate-200 rounded-xl border border-slate-200">
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
                    className="min-w-0 select-text break-all font-mono text-xs leading-5 text-blue-700 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-blue-700"
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
