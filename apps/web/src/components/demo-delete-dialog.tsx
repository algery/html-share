"use client";

import { useState } from "react";
import type { DemoSummary } from "./demo-list";

export function DeleteEntry({
  apiUrl,
  csrfToken,
  demo,
  onClose,
  onDeleted,
}: {
  apiUrl: string;
  csrfToken: string | null;
  demo: DemoSummary;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const canDelete = confirmation === demo.projectId && !submitting;

  async function confirmDeletion() {
    if (!canDelete) return;
    if (csrfToken === null) {
      setError("安全校验已过期，请重新登录后再试。");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`${apiUrl}/api/projects/${demo.projectId}/delete`, {
        body: JSON.stringify({ confirmation }),
        credentials: "include",
        headers: { "content-type": "application/json", "x-html-share-csrf": csrfToken },
        method: "POST",
      });
      if (!response.ok) throw new Error("delete_request_failed");
      await onDeleted();
      onClose();
    } catch {
      setError("删除未完成，请重试；若问题持续，请携带诊断编号 DEMO_DELETE_FAILED 联系管理员。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      aria-labelledby="delete-entry-title"
      aria-modal="true"
      className="fixed inset-0 z-10 flex items-end bg-slate-950/40 p-4 sm:items-center sm:justify-center"
      role="dialog"
    >
      <section className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold" id="delete-entry-title">
          删除 Demo
        </h2>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          将删除「{demo.displayName}」（项目标识：<code>{demo.projectId}</code>
          ）。删除不可恢复，确认后所有链接会立即失效，文件将在 24 小时内清理。
        </p>
        <label
          className="mt-5 block text-sm font-medium text-slate-800"
          htmlFor="delete-project-id"
        >
          输入项目标识 <code>{demo.projectId}</code> 以确认
        </label>
        <input
          autoComplete="off"
          className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 px-3 font-mono text-sm focus:outline-2 focus:outline-offset-2 focus:outline-blue-700"
          id="delete-project-id"
          onChange={(event) => setConfirmation(event.target.value)}
          value={confirmation}
        />
        {error === null ? null : (
          <p className="mt-3 text-sm text-rose-700" role="alert">
            {error}
          </p>
        )}
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button
            className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700"
            onClick={onClose}
            type="button"
          >
            取消
          </button>
          <button
            className="min-h-11 rounded-lg bg-rose-700 px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-rose-300 hover:bg-rose-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700"
            disabled={!canDelete}
            onClick={() => void confirmDeletion()}
            type="button"
          >
            {submitting ? "正在删除…" : "永久删除"}
          </button>
        </div>
      </section>
    </div>
  );
}
