"use client";

import { useEffect, useRef } from "react";
import { SQUARE_SCOPE_NOTICE } from "../lib/square-types";

export function ProjectSquareConfirmDialog({
  summary,
  onCancel,
  onConfirm,
  submitting,
}: {
  summary: string;
  onCancel: () => void;
  onConfirm: () => void;
  submitting: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (submitting) dialogRef.current?.focus();
  }, [submitting]);
  return (
    <div
      aria-labelledby="square-confirm-title"
      aria-describedby="square-confirm-description"
      aria-modal="true"
      className="fixed inset-0 z-20 flex items-end overflow-y-auto bg-slate-950/40 p-4 sm:items-center sm:justify-center"
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !submitting) onCancel();
        if (event.key !== "Tab") return;
        const buttons = Array.from(
          dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
        );
        const first = buttons[0];
        const last = buttons.at(-1);
        if (!first || (event.shiftKey && document.activeElement === first)) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <section className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 className="section-title" id="square-confirm-title">
          发布到项目广场？
        </h2>
        <p className="mt-3 break-words text-sm font-medium">可见范围：{summary}</p>
        <p className="mt-3 text-sm leading-6 text-slate-600" id="square-confirm-description">
          {SQUARE_SCOPE_NOTICE}
        </p>
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button
            autoFocus
            className="button-secondary"
            disabled={submitting}
            onClick={onCancel}
            type="button"
          >
            取消
          </button>
          <button
            className="button-primary"
            disabled={submitting}
            onClick={onConfirm}
            type="button"
          >
            {submitting ? "正在发布…" : "确认发布"}
          </button>
        </div>
      </section>
    </div>
  );
}
