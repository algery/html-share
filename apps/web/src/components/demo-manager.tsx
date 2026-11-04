"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { type DemoSummary } from "./demo-list";
import { ManagementIcon } from "./management-icon";
import { DemoBrowser } from "./demo-browser";

interface DemoManagerProps {
  apiUrl: string;
}

export interface DemoResponse {
  csrfToken: string | null;
  projects: DemoSummary[];
  quota: {
    projectCount: number;
    projectLimit: number;
    storageBytes: number;
    storageLimitBytes: number;
  };
}

type LoadState = "error" | "expired" | "loading" | "ready";

export function DemoManager({ apiUrl }: DemoManagerProps) {
  const endpoint = useMemo(() => `${apiUrl}/api/projects`, [apiUrl]);
  const [data, setData] = useState<DemoResponse | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState("loading");
    setNotice(null);
    try {
      const data = await requestDemoList(endpoint);
      setData(data);
      setState("ready");
      setNotice("项目列表已更新。");
    } catch (error) {
      setState(error instanceof DemoListRequestError && error.status === 401 ? "expired" : "error");
    }
  }, [endpoint]);

  useEffect(() => {
    let active = true;
    void requestDemoList(endpoint).then(
      (data) => {
        if (!active) return;
        setData(data);
        setState("ready");
      },
      (error: unknown) => {
        if (!active) return;
        setState(
          error instanceof DemoListRequestError && error.status === 401 ? "expired" : "error",
        );
      },
    );
    return () => {
      active = false;
    };
  }, [endpoint]);

  return (
    <main className="workspace">
      <section>
        <div className="workspace-header">
          <div>
            <h1 className="page-title">我的 Demo</h1>
          </div>
          <div className="contents sm:flex sm:flex-wrap sm:items-center sm:gap-x-6 sm:gap-y-2">
            {data !== null ? <Quota quota={data.quota} /> : null}
            <button
              className="button-secondary"
              disabled={state === "loading"}
              onClick={() => void refresh()}
              type="button"
            >
              <ManagementIcon
                name="refresh"
                className={state === "loading" ? "animate-spin" : ""}
              />
              重新加载
            </button>
          </div>
        </div>
        <div aria-live="polite" className="sr-only">
          {notice}
        </div>
        {state === "loading" && data === null ? <DemoSkeleton /> : null}
        {state === "expired" ? <ExpiredState /> : null}
        {state === "error" ? (
          <ErrorState onRetry={refresh} hasPreviousData={data !== null} />
        ) : null}
        {(state === "ready" || state === "loading" || state === "error") && data !== null ? (
          <DemoContent apiUrl={apiUrl} data={data} onDeleted={refresh} />
        ) : null}
      </section>
    </main>
  );
}

function DemoContent({
  apiUrl,
  data,
  onDeleted,
}: {
  apiUrl: string;
  data: DemoResponse;
  onDeleted: () => Promise<void>;
}) {
  return (
    <>
      {data.projects.length === 0 ? (
        <EmptyState />
      ) : (
        <DemoBrowser apiUrl={apiUrl} data={data} onDeleted={onDeleted} />
      )}
    </>
  );
}

function Quota({ quota }: { quota: DemoResponse["quota"] }) {
  return (
    <section
      aria-label="当前用量"
      className="order-last flex w-full flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-500 sm:order-none sm:w-auto"
    >
      <QuotaMeter
        label="项目数"
        value={`${quota.projectCount} / ${quota.projectLimit}`}
        percent={(quota.projectCount / quota.projectLimit) * 100}
      />
      <QuotaMeter
        label="存储用量"
        value={`${formatStorage(quota.storageBytes)} / 2 GB`}
        percent={(quota.storageBytes / quota.storageLimitBytes) * 100}
      />
    </section>
  );
}
function QuotaMeter({ label, value, percent }: { label: string; value: string; percent: number }) {
  return (
    <div className="quota-meter">
      <div>
        <span>{label}</span>
        <span className="ml-2 font-medium tabular-nums text-slate-700">{value}</span>
      </div>
      <span className="quota-track" data-warning={percent >= 80} aria-hidden="true">
        <span style={{ width: `${Math.min(percent, 100)}%` }} />
      </span>
    </div>
  );
}

function DemoSkeleton() {
  return (
    <div aria-label="正在加载 Demo" aria-busy="true">
      <div className="mb-4">
        <input
          aria-label="搜索项目名"
          className="field sm:max-w-80"
          type="search"
          placeholder="搜索项目名"
          disabled
        />
      </div>
      <div className="table-shell hidden md:block">
        <table className="data-table">
          <thead>
            <tr>
              {["名称", "首页链接", "访问方式", "文件 / 大小", "时间", "分享"].map((label) => (
                <th key={label} className="px-3 py-3">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
        </table>
        {Array.from({ length: 8 }, (_, row) => (
          <div
            aria-hidden="true"
            key={row}
            className="flex h-16 items-center gap-12 border-t border-slate-200 px-3"
          >
            <span className="h-3 w-1/4 animate-pulse rounded bg-slate-100" />
            <span className="h-3 w-1/6 animate-pulse rounded bg-slate-100" />
            <span className="h-6 w-16 animate-pulse rounded bg-slate-100" />
            <span className="ml-auto h-9 w-28 animate-pulse rounded bg-slate-100" />
          </div>
        ))}
      </div>
      <div className="grid gap-3 md:hidden">
        {[0, 1, 2].map((row) => (
          <div
            aria-hidden="true"
            key={row}
            className="h-52 animate-pulse rounded-lg border border-slate-200 bg-white"
          />
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <section className="mt-8 rounded-xl bg-slate-50 p-6" aria-labelledby="empty-demo-title">
      <h2 className="font-semibold" id="empty-demo-title">
        还没有 Demo
      </h2>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        安装 Agent 能力后，在 Codex 或 Claude Code 中说“分享这个 Demo”即可发布。
      </p>
      <Link
        className="mt-4 inline-flex min-h-11 items-center rounded-lg bg-blue-700 px-4 text-sm font-semibold text-white hover:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700"
        href="/tokens"
      >
        安装 Agent 能力
      </Link>
    </section>
  );
}

function ErrorState({
  onRetry,
  hasPreviousData,
}: {
  onRetry: () => Promise<void>;
  hasPreviousData: boolean;
}) {
  return (
    <section
      className="mt-8 rounded-xl bg-rose-50 p-5 text-sm leading-6 text-rose-900"
      role="alert"
    >
      <h2 className="font-semibold">无法加载 Demo</h2>
      {hasPreviousData ? (
        <p className="mt-1">当前展示上次加载的数据；重试将保留搜索和分页。</p>
      ) : null}
      <p className="mt-1">
        请重试；若问题持续，请携带诊断编号 DEMO_LIST_REQUEST_FAILED 联系管理员。
      </p>
      <button
        className="mt-4 min-h-10 rounded-md border border-rose-300 bg-white px-3 font-semibold hover:bg-rose-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700"
        onClick={() => void onRetry()}
        type="button"
      >
        重试
      </button>
    </section>
  );
}

function ExpiredState() {
  return (
    <section
      className="mt-8 rounded-xl bg-amber-50 p-5 text-sm leading-6 text-amber-950"
      role="alert"
    >
      <h2 className="font-semibold">登录状态已过期</h2>
      <p className="mt-1">请重新完成钉钉登录后再管理你的 Demo。</p>
      <Link
        className="mt-4 inline-flex min-h-10 items-center rounded-md bg-amber-800 px-3 font-semibold text-white hover:bg-amber-900 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700"
        href="/login"
      >
        前往登录
      </Link>
    </section>
  );
}

function formatStorage(bytes: number) {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

class DemoListRequestError extends Error {
  constructor(readonly status: number) {
    super("project_list_request_failed");
  }
}

async function requestDemoList(endpoint: string): Promise<DemoResponse> {
  const response = await fetch(endpoint, { credentials: "include" });
  if (!response.ok) throw new DemoListRequestError(response.status);
  return (await response.json()) as DemoResponse;
}
