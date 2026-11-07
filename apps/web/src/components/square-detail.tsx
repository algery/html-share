"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { SquareDetailResponse } from "../lib/square-types";
import { formatBytes, formatDate } from "./demo-list";
import { SquareLoadState } from "./square-load-state";

type DetailState =
  | { status: "loading" | "error" | "expired" | "missing" }
  | { status: "ready"; data: SquareDetailResponse };

export function SquareDetail({ apiUrl, projectId }: { apiUrl: string; projectId: string }) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void fetch(`${apiUrl}/api/square/projects/${encodeURIComponent(projectId)}`, {
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
        const data = (await response.json()) as SquareDetailResponse;
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
  return (
    <main className="workspace">
      <Link
        className="inline-flex min-h-10 items-center text-sm font-semibold text-blue-700 hover:underline focus-visible:outline-2 focus-visible:outline-blue-700"
        href="/square"
      >
        返回项目广场
      </Link>
      <div className="workspace-header mt-4">
        <h1 className="page-title">
          {state.status === "ready" ? state.data.project.displayName : "项目内容"}
        </h1>
        <button
          className="button-secondary"
          disabled={state.status === "loading"}
          onClick={reload}
          type="button"
        >
          重新加载
        </button>
      </div>
      {state.status === "ready" ? (
        <SquareFiles data={state.data} />
      ) : (
        <SquareLoadState status={state.status} onRetry={reload} />
      )}
    </main>
  );
}

function SquareFiles({ data }: { data: SquareDetailResponse }) {
  const [query, setQuery] = useState("");
  const visible = data.files.filter((file) =>
    file.relativePath.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <>
      <dl className="mb-5 grid grid-cols-2 gap-x-5 gap-y-3 border-b border-slate-200 pb-5 text-sm sm:grid-cols-4">
        {[
          ["创建者", data.project.creatorDisplayName],
          ["内容更新时间", formatDate(data.project.updatedAt)],
          ["文件数", String(data.project.fileCount)],
          ["总大小", formatBytes(data.project.totalSize)],
        ].map(([label, value]) => (
          <div className="min-w-0" key={label}>
            <dt className="text-slate-500">{label}</dt>
            <dd className="mt-1 break-words font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      {data.project.homepage?.url ? (
        <a
          className="button-primary mb-5"
          href={data.project.homepage.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          查看内容
        </a>
      ) : (
        <p className="mb-5 text-sm text-slate-500">从项目内容选择文件</p>
      )}
      <section aria-labelledby="square-files-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="section-title" id="square-files-title">
              全部文件（{data.files.length}）
            </h2>
            <p aria-live="polite" className="mt-1 text-xs text-slate-500">
              显示 {visible.length} / {data.files.length} 个文件
            </p>
          </div>
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
        </div>
        {data.files.length === 0 ? (
          <p className="mt-4 rounded-lg bg-slate-100 p-5 text-sm text-slate-600">
            当前项目暂无已发布文件。
          </p>
        ) : visible.length === 0 ? (
          <div className="mt-3 rounded-lg bg-slate-100 p-4 text-sm text-slate-600">
            <p>没有匹配的文件。</p>
            <button className="button-secondary mt-2" onClick={() => setQuery("")} type="button">
              清空搜索
            </button>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
            {visible.map((file) => (
              <li className="min-w-0 px-3 py-2.5" key={file.relativePath}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h3 className="min-w-0 break-all font-mono text-sm font-medium">
                    {file.relativePath}
                  </h3>
                  <span className="shrink-0 text-xs text-slate-500">{formatBytes(file.size)}</span>
                </div>
                <a
                  className="mt-1 flex min-h-10 min-w-0 items-center break-all font-mono text-xs leading-5 text-blue-700 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-blue-700"
                  href={file.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {file.url}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
