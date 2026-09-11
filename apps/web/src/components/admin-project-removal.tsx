"use client";

import { useMemo, useState } from "react";

interface AdminProjectRemovalProps {
  apiUrl: string;
}

interface ProjectMetadata {
  createdAt: string;
  displayName: string;
  ownerDisplayName: string;
  projectKey: string;
  status: "active" | "deleted" | "pending";
  totalSize: number;
  updatedAt: string;
}

export function AdminProjectRemoval({ apiUrl }: AdminProjectRemovalProps) {
  const [projectKey, setProjectKey] = useState("");
  const [project, setProject] = useState<ProjectMetadata | null>(null);
  const [reason, setReason] = useState("");
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [state, setState] = useState<
    "error" | "idle" | "loading" | "removing" | "ready" | "removed"
  >("idle");
  const endpoint = useMemo(
    () => `${apiUrl}/api/admin/projects/${projectKey}`,
    [apiUrl, projectKey],
  );

  async function lookup() {
    if (!/^[a-z0-9]{5}$/.test(projectKey)) return;
    setState("loading");
    try {
      const response = await fetch(endpoint, { credentials: "include" });
      if (!response.ok) throw new Error("lookup_failed");
      const payload = (await response.json()) as { project: ProjectMetadata };
      const csrfResponse = await fetch(`${apiUrl}/api/csrf`, { credentials: "include" });
      if (!csrfResponse.ok) throw new Error("csrf_failed");
      const csrf = (await csrfResponse.json()) as { csrfToken: string | null };
      if (csrf.csrfToken === null) throw new Error("csrf_missing");
      setProject(payload.project);
      setCsrfToken(csrf.csrfToken);
      setReason("");
      setState("ready");
    } catch {
      setProject(null);
      setState("error");
    }
  }

  async function remove() {
    if (
      project === null ||
      csrfToken === null ||
      reason.trim().length < 10 ||
      reason.trim().length > 500
    ) {
      return;
    }
    setState("removing");
    try {
      const response = await fetch(`${endpoint}/delete`, {
        body: JSON.stringify({ reason }),
        credentials: "include",
        headers: { "content-type": "application/json", "x-html-share-csrf": csrfToken },
        method: "POST",
      });
      if (!response.ok) throw new Error("delete_failed");
      setState("removed");
    } catch {
      setState("error");
    }
  }

  const validProjectKey = /^[a-z0-9]{5}$/.test(projectKey);
  const validReason = [...reason.trim()].length >= 10 && [...reason.trim()].length <= 500;
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      <section className="rounded-2xl border border-rose-200 bg-white p-6 shadow-sm sm:p-10">
        <p className="text-sm font-semibold text-rose-700">管理员应急止损</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">永久删除一个 Demo</h1>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          仅能按准确项目标识查询元数据，不能浏览项目或文件。删除不可恢复，操作原因将写入审计日志。
        </p>
        <label className="mt-7 block text-sm font-medium" htmlFor="admin-project-key">
          项目标识
        </label>
        <div className="mt-2 flex gap-3">
          <input
            autoComplete="off"
            className="min-h-11 min-w-0 flex-1 rounded-lg border border-slate-300 px-3 font-mono text-sm lowercase focus:outline-2 focus:outline-offset-2 focus:outline-blue-700"
            id="admin-project-key"
            maxLength={5}
            onChange={(event) => setProjectKey(event.target.value.toLowerCase())}
            value={projectKey}
          />
          <button
            className="min-h-11 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:bg-slate-300"
            disabled={!validProjectKey || state === "loading" || state === "removing"}
            onClick={() => void lookup()}
            type="button"
          >
            查询
          </button>
        </div>
        {project === null ? null : (
          <dl className="mt-6 grid gap-3 rounded-xl bg-slate-50 p-4 text-sm sm:grid-cols-2">
            <Detail label="名称" value={project.displayName} />
            <Detail label="创建者" value={project.ownerDisplayName} />
            <Detail label="状态" value={project.status} />
            <Detail label="大小" value={`${project.totalSize} B`} />
          </dl>
        )}
        {project === null || state === "removed" ? null : (
          <>
            <label className="mt-6 block text-sm font-medium" htmlFor="admin-delete-reason">
              合规删除原因（10–500 字）
            </label>
            <textarea
              className="mt-2 min-h-28 w-full rounded-lg border border-slate-300 p-3 text-sm focus:outline-2 focus:outline-offset-2 focus:outline-blue-700"
              id="admin-delete-reason"
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              value={reason}
            />
            <p className="mt-1 text-xs text-slate-500">{[...reason.trim()].length} / 500</p>
            <button
              className="mt-5 min-h-11 rounded-lg bg-rose-700 px-4 text-sm font-semibold text-white disabled:bg-rose-300"
              disabled={!validReason || state === "removing"}
              onClick={() => void remove()}
              type="button"
            >
              {state === "removing" ? "正在永久删除…" : "确认永久删除"}
            </button>
          </>
        )}
        {state === "removed" ? (
          <Notice text="项目已删除，所有链接已立即失效；文件将由清理队列处理。" />
        ) : null}
        {state === "error" ? (
          <Notice text="请求未完成或无权限。请核对项目标识和管理员身份。" />
        ) : null}
      </section>
    </main>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="mt-1 break-all font-medium">{value}</dd>
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <p className="mt-6 rounded-lg bg-rose-50 p-3 text-sm text-rose-900" role="status">
      {text}
    </p>
  );
}
