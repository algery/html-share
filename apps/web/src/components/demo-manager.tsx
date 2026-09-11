"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { DemoList, type DemoSummary } from "./demo-list";

interface DemoManagerProps {
  apiUrl: string;
}

interface DemoResponse {
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
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-blue-700">我的 Demo</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
              管理已发布的 Demo
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600">
              Demo 通过 Codex 或 Claude Code 发布。点击项目名称可查看全部文件并复制文件链接。
            </p>
          </div>
          <button
            className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700"
            onClick={() => void refresh()}
            type="button"
          >
            重新加载
          </button>
        </div>
        <div aria-live="polite" className="sr-only">
          {notice}
        </div>
        {state === "loading" ? <DemoSkeleton /> : null}
        {state === "expired" ? <ExpiredState /> : null}
        {state === "error" ? <ErrorState onRetry={refresh} /> : null}
        {state === "ready" && data !== null ? (
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
      <Quota quota={data.quota} />
      {data.projects.length === 0 ? (
        <EmptyState />
      ) : (
        <section className="mt-8" aria-labelledby="demo-list-title">
          <h2 className="text-lg font-semibold tracking-tight" id="demo-list-title">
            已发布的 Demo
          </h2>
          <div className="mt-4">
            <DemoList
              apiUrl={apiUrl}
              csrfToken={data.csrfToken}
              demos={data.projects}
              onDeleted={onDeleted}
            />
          </div>
        </section>
      )}
    </>
  );
}

function Quota({ quota }: { quota: DemoResponse["quota"] }) {
  const projectPercent = (quota.projectCount / quota.projectLimit) * 100;
  const storagePercent = (quota.storageBytes / quota.storageLimitBytes) * 100;
  return (
    <section className="mt-8 grid gap-3 sm:grid-cols-2" aria-label="当前用量">
      <QuotaCard
        label="项目数"
        value={`${quota.projectCount} / ${quota.projectLimit}`}
        percent={projectPercent}
      />
      <QuotaCard
        label="存储用量"
        value={`${formatStorage(quota.storageBytes)} / 2 GB`}
        percent={storagePercent}
      />
    </section>
  );
}

function QuotaCard({ label, percent, value }: { label: string; percent: number; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm text-slate-600">{label}</p>
        <p className="font-semibold">{value}</p>
      </div>
      <div aria-hidden="true" className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
        <div
          className="h-full rounded-full bg-blue-700"
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
    </div>
  );
}

function DemoSkeleton() {
  return (
    <div aria-label="正在加载 Demo" className="mt-8 grid gap-3">
      <div className="h-28 animate-pulse rounded-xl bg-slate-100" />
      <div className="h-60 animate-pulse rounded-xl bg-slate-100" />
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

function ErrorState({ onRetry }: { onRetry: () => Promise<void> }) {
  return (
    <section
      className="mt-8 rounded-xl bg-rose-50 p-5 text-sm leading-6 text-rose-900"
      role="alert"
    >
      <h2 className="font-semibold">无法加载 Demo</h2>
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
