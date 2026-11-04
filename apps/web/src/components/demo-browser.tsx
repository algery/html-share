"use client";

import { ManagementIcon } from "./management-icon";
import { useState } from "react";
import { DemoList } from "./demo-list";
import type { DemoResponse } from "./demo-manager";

const buttonClass =
  "min-h-10 md:min-h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-40 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-blue-700";

export function DemoBrowser({
  apiUrl,
  data,
  onDeleted,
}: {
  apiUrl: string;
  data: DemoResponse;
  onDeleted: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const keyword = query.trim().toLowerCase();
  const projects = data.projects.filter((project) =>
    project.displayName.toLowerCase().includes(keyword),
  );
  const pages = Math.max(1, Math.ceil(projects.length / pageSize));
  const currentPage = Math.min(page, pages);
  if (page !== currentPage) setPage(currentPage);
  const start = (currentPage - 1) * pageSize;
  const visible = projects.slice(start, start + pageSize);
  function clearSearch() {
    setQuery("");
    setPage(1);
  }
  return (
    <section className="min-w-0" aria-labelledby="demo-list-title">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="sr-only" id="demo-list-title">
            已发布的 Demo
          </h2>
          <p className="text-sm text-slate-500" aria-live="polite">
            共 {data.projects.length} 个项目{keyword ? `，匹配 ${projects.length} 个` : ""}
          </p>
        </div>
        <label className="relative w-full sm:order-first sm:w-80">
          <span className="sr-only">搜索项目名</span>
          <ManagementIcon
            name="search"
            className="pointer-events-none absolute left-3 top-3 text-slate-400"
          />
          <input
            className="field pl-10"
            type="search"
            autoComplete="off"
            placeholder="搜索项目名"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
          />
        </label>
      </div>
      <div className="mt-0">
        {projects.length === 0 ? (
          <div className="rounded-xl bg-slate-50 p-6 text-sm text-slate-600">
            <p>没有匹配的项目。</p>
            <button
              className="mt-2 min-h-10 md:min-h-9 font-semibold text-blue-700 hover:underline"
              onClick={clearSearch}
              type="button"
            >
              清空搜索
            </button>
          </div>
        ) : (
          <DemoList
            apiUrl={apiUrl}
            csrfToken={data.csrfToken}
            demos={visible}
            onDeleted={onDeleted}
          />
        )}
      </div>
      <nav
        className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600"
        aria-label="项目分页"
      >
        <div className="flex flex-wrap items-center gap-3">
          <span aria-live="polite">
            {projects.length ? start + 1 : 0}–{Math.min(start + pageSize, projects.length)} /{" "}
            {projects.length} 个
          </span>
          <label>
            每页{" "}
            <select
              aria-label="每页条数"
              className="min-h-10 md:min-h-9 rounded-lg border border-slate-300 bg-white px-2"
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
            >
              {[10, 20, 50].map((size) => (
                <option key={size} value={size}>
                  {size} 条
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button
            className={buttonClass}
            disabled={currentPage === 1}
            onClick={() => setPage(currentPage - 1)}
            type="button"
          >
            上一页
          </button>
          <span aria-live="polite">
            第 {currentPage} / {pages} 页
          </span>
          <button
            className={buttonClass}
            disabled={currentPage === pages}
            onClick={() => setPage(currentPage + 1)}
            type="button"
          >
            下一页
          </button>
        </div>
      </nav>
    </section>
  );
}
