"use client";

import { useEffect, useState } from "react";
import type { SquareListResponse } from "../lib/square-types";
import { ManagementIcon } from "./management-icon";
import { SquareProjectList } from "./square-project-list";
import { SquareLoadState } from "./square-load-state";

export function SquareBrowser({ apiUrl }: { apiUrl: string }) {
  const [query, setQuery] = useState("");
  const [creatorQuery, setCreatorQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<SquareListResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "expired">("loading");
  const keyword = query.trim();
  const creator = creatorQuery.trim();
  const filtered = Boolean(keyword || creator);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setStatus("loading");
    const params = new URLSearchParams({
      q: keyword,
      creator,
      page: String(page),
      pageSize: String(pageSize),
    });
    void fetch(`${apiUrl}/api/square/projects?${params}`, {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setStatus(response.status === 401 ? "expired" : "error");
          return;
        }
        const next = (await response.json()) as SquareListResponse;
        if (!controller.signal.aborted) {
          setData(next);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("error");
      });
    return () => controller.abort();
  }, [apiUrl, keyword, creator, page, pageSize, attempt]);
  function reload() {
    setData(null);
    setStatus("loading");
    setAttempt((value) => value + 1);
  }
  const currentPage = data?.page ?? page;
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));
  return (
    <main className="workspace">
      <div className="workspace-header">
        <h1 className="page-title">项目广场</h1>
        <button
          className="button-secondary"
          disabled={status === "loading"}
          onClick={reload}
          type="button"
        >
          <ManagementIcon name="refresh" />
          重新加载
        </button>
      </div>
      <section aria-label="可见项目" className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="grid w-full gap-3 sm:max-w-xl sm:grid-cols-2">
            {[
              { label: "搜索项目名", value: query, change: setQuery },
              { label: "搜索创建者", value: creatorQuery, change: setCreatorQuery },
            ].map(({ label, value, change }) => (
              <label className="relative min-w-0" key={label}>
                <span className="sr-only">{label}</span>
                <ManagementIcon
                  name="search"
                  className="pointer-events-none absolute left-3 top-3 text-slate-400"
                />
                <input
                  autoComplete="off"
                  className="field pl-10"
                  maxLength={80}
                  onChange={(event) => {
                    change(event.target.value);
                    setPage(1);
                  }}
                  placeholder={label}
                  type="search"
                  value={value}
                />
              </label>
            ))}
          </div>
          <p aria-live="polite" className="text-sm text-slate-500">
            {data === null
              ? status === "loading"
                ? "正在确认可见项目"
                : "暂未加载可见项目"
              : `共 ${data.total} 个${filtered ? "匹配" : "可见"}项目`}
          </p>
        </div>
        {status !== "ready" ? <SquareLoadState list status={status} onRetry={reload} /> : null}
        {data !== null ? (
          <>
            {data.directoryUnavailable ? (
              <p
                className="mb-4 rounded-lg bg-amber-50 p-3 text-sm leading-6 text-amber-900"
                role="status"
              >
                组织目录暂不可用，部分指定范围项目无法确认资格，暂不展示。可重新加载重试。
              </p>
            ) : null}
            {data.projects.length > 0 ? (
              <SquareProjectList projects={data.projects} />
            ) : (
              <div className="rounded-lg bg-slate-100 p-6 text-sm text-slate-600">
                <p>
                  {filtered
                    ? "没有匹配的项目。"
                    : "暂无可见项目。创建者共享后，符合范围的项目会出现在这里。"}
                </p>
                {filtered ? (
                  <button
                    className="button-secondary mt-3"
                    onClick={() => {
                      setQuery("");
                      setCreatorQuery("");
                      setPage(1);
                    }}
                    type="button"
                  >
                    清空搜索
                  </button>
                ) : null}
              </div>
            )}
            <nav
              aria-label="广场分页"
              className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span aria-live="polite">
                  {data.total ? (currentPage - 1) * pageSize + 1 : 0}–
                  {Math.min(currentPage * pageSize, data.total)} / {data.total} 个
                </span>
                <label>
                  每页{" "}
                  <select
                    aria-label="每页条数"
                    className="min-h-10 rounded-lg border border-slate-300 bg-white px-2"
                    value={pageSize}
                    onChange={(event) => {
                      setPageSize(Number(event.target.value));
                      setPage(1);
                    }}
                  >
                    {[10, 20, 50].map((size) => (
                      <option value={size} key={size}>
                        {size} 条
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="button-secondary"
                  disabled={currentPage <= 1}
                  onClick={() => setPage(currentPage - 1)}
                  type="button"
                >
                  上一页
                </button>
                <span aria-live="polite">
                  第 {currentPage} / {pages} 页
                </span>
                <button
                  className="button-secondary"
                  disabled={currentPage >= pages}
                  onClick={() => setPage(currentPage + 1)}
                  type="button"
                >
                  下一页
                </button>
              </div>
            </nav>
          </>
        ) : null}
      </section>
    </main>
  );
}
