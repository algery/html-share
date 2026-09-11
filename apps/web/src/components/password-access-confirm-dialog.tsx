"use client";

import { useEffect, useRef } from "react";

export type PasswordAccessAction = "disable" | "enable" | "regenerate";

const secondaryButton =
  "min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700 disabled:cursor-not-allowed disabled:text-slate-400";

export function PasswordAccessConfirmDialog({
  action,
  onCancel,
  onConfirm,
  submitting,
}: {
  action: PasswordAccessAction;
  onCancel: () => void;
  onConfirm: () => void;
  submitting: boolean;
}) {
  const content = confirmationCopy(action);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (submitting) dialogRef.current?.focus();
  }, [submitting]);

  function trapFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return (
    <div
      aria-labelledby="password-confirm-title"
      aria-modal="true"
      className="fixed inset-0 z-20 flex items-end bg-slate-950/40 p-4 sm:items-center sm:justify-center"
      onKeyDown={trapFocus}
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <section className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold" id="password-confirm-title">
          {content.title}
        </h2>
        <p className="mt-3 text-sm leading-6 text-slate-600">{content.description}</p>
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button
            autoFocus
            className={secondaryButton}
            disabled={submitting}
            onClick={onCancel}
            type="button"
          >
            取消
          </button>
          <button
            className="min-h-10 rounded-lg bg-blue-700 px-4 text-sm font-semibold text-white hover:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
            disabled={submitting}
            onClick={onConfirm}
            type="button"
          >
            {submitting ? "正在提交…" : content.confirm}
          </button>
        </div>
      </section>
    </div>
  );
}

function confirmationCopy(action: PasswordAccessAction) {
  if (action === "enable") {
    return {
      confirm: "确认开启",
      description: "系统会生成访问密码。项目文件、链接和当前版本保持不变。",
      title: "开启密码访问？",
    };
  }
  if (action === "regenerate") {
    return {
      confirm: "确认重新生成",
      description: "旧密码和已发出的密码访问凭证会立即失效，项目文件和链接保持不变。",
      title: "重新生成密码？",
    };
  }
  return {
    confirm: "确认关闭",
    description: "旧密码和已发出的密码访问凭证会立即失效，之后仅组织成员可访问。",
    title: "关闭密码访问？",
  };
}
