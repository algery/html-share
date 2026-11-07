"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { DemoDetailSettings } from "./demo-detail-settings";
import { formatBytes, formatDate, type DemoSummary } from "./demo-list";
import { ManagementIcon } from "./management-icon";
import { ProjectFiles, type ProjectFile } from "./demo-detail-files";
import type { ProjectAccessState } from "./password-access-manager";

interface DemoDetailResponse {
  csrfToken: string | null;
  project: Omit<DemoSummary, "projectPrefix"> & ProjectAccessState;
  files: ProjectFile[];
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
  const [query, setQuery] = useState("");
  const [homepageNeedsRefresh, setHomepageNeedsRefresh] = useState(false);
  const [homepageSaving, setHomepageSaving] = useState(false);

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
        if (!controller.signal.aborted) {
          setState({ status: "ready", data });
          setHomepageNeedsRefresh(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "error" });
      });
    return () => controller.abort();
  }, [apiUrl, projectId, attempt]);

  async function reloadHomepage() {
    setHomepageNeedsRefresh(true);
    const response = await fetch(`${apiUrl}/api/projects/${encodeURIComponent(projectId)}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("homepage_reload_failed");
    setState({ status: "ready", data: (await response.json()) as DemoDetailResponse });
    setHomepageNeedsRefresh(false);
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

  const homepageUrl = state.status === "ready" ? state.data.project.homepage?.url : null;

  return (
    <main className="workspace">
      <section className="min-w-0">
        <Link className={`inline-flex min-h-10 items-center ${linkClass}`} href="/demos">
          返回我的 Demo
        </Link>
        <div className="workspace-header mt-4">
          <div className="min-w-0 flex-1 basis-full sm:basis-auto">
            <h1 className="page-title">
              {state.status === "ready" ? state.data.project.displayName : "项目详情"}
            </h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className={buttonClass}
              disabled={state.status === "loading" || homepageSaving}
              onClick={reload}
              type="button"
            >
              重新加载
            </button>
            {state.status === "ready" && (homepageSaving || homepageNeedsRefresh) ? (
              <button className="button-primary" disabled type="button">
                访问
              </button>
            ) : homepageUrl ? (
              <a
                aria-label="访问（在新标签页打开）"
                className="button-primary"
                href={homepageUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                访问 <ManagementIcon name="arrow" />
              </a>
            ) : state.status === "ready" ? (
              <a className="button-primary" href="#project-homepage-file">
                设置首页
              </a>
            ) : null}
          </div>
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
            <dl className="mb-6 grid grid-cols-2 gap-x-5 gap-y-3  text-sm sm:grid-cols-4">
              {[
                ["项目标识", state.data.project.projectId],
                ["文件数", String(state.data.project.fileCount)],
                ["总大小", formatBytes(state.data.project.totalSize)],
                ["更新时间", formatDate(state.data.project.updatedAt)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-slate-500">{label}</dt>
                  <dd className="mt-1 break-all font-medium">{value}</dd>
                </div>
              ))}
            </dl>
            <DemoDetailSettings
              apiUrl={apiUrl}
              csrfToken={state.data.csrfToken}
              files={state.data.files}
              onAccessChanged={updateAccess}
              onHomepageSaved={reloadHomepage}
              onHomepageSavingChange={setHomepageSaving}
              project={state.data.project}
              projectId={projectId}
            />
            <ProjectFiles
              files={state.data.files}
              access={state.data.project}
              query={query}
              onQueryChange={setQuery}
            />
          </>
        ) : null}
      </section>
    </main>
  );
}
