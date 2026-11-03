"use client";

import { useState } from "react";

interface CopyCodeButtonProps {
  compact?: boolean;
  disabledReason?: string;
  failureValue?: string;
  label?: string;
  successMessage?: string;
  resolveValue?: () => Promise<string>;
  value: string;
}

export class CopyValueError extends Error {}

export function CopyCodeButton({
  compact = false,
  disabledReason,
  failureValue,
  label = "复制配置",
  successMessage = "已复制",
  resolveValue,
  value,
}: CopyCodeButtonProps) {
  const [message, setMessage] = useState<string | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function copy() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    setFallback(null);
    try {
      const pendingValue = resolveValue
        ? Promise.resolve().then(resolveValue)
        : Promise.resolve(value);
      // Start writing during the click gesture, before the network await (WebKit).
      let pendingWrite: Promise<boolean> | null = null;
      if (resolveValue && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        try {
          const blob = pendingValue.then((text) => new Blob([text], { type: "text/plain" }));
          void blob.catch(() => undefined);
          pendingWrite = navigator.clipboard
            .write([new ClipboardItem({ "text/plain": blob })])
            .then(
              () => true,
              () => false,
            );
        } catch {
          pendingWrite = Promise.resolve(false);
        }
      }
      let resolved: string;
      try {
        resolved = resolveValue ? await pendingValue : value;
      } catch (error) {
        setMessage(error instanceof CopyValueError ? error.message : "获取分享信息失败，请重试。");
        return;
      }
      try {
        if (pendingWrite !== null) {
          if (!(await pendingWrite)) throw new Error("clipboard_unavailable");
        } else await navigator.clipboard.writeText(resolved);
        setMessage(successMessage);
      } catch {
        setMessage("复制失败，请手动复制");
        setFallback(failureValue ?? resolved);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={`${compact ? "mt-0 shrink-0" : "mt-2"} inline-grid max-w-full gap-2`}>
      <span className="inline-flex max-w-full flex-wrap items-center gap-2">
        <button
          className={`${compact ? "min-h-8 px-2.5" : "min-h-9 px-3"} shrink-0 whitespace-nowrap rounded-md border border-slate-300 bg-white text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700`}
          aria-busy={busy}
          disabled={busy || disabledReason !== undefined}
          onClick={() => void copy()}
          type="button"
        >
          {busy ? "正在复制…" : label}
        </button>
        <span aria-live="polite" className="text-xs text-slate-600">
          {disabledReason ?? message}
        </span>
      </span>
      {fallback !== null ? (
        <textarea
          aria-label="手动复制内容"
          className="min-h-20 w-full resize-y rounded-md border border-slate-300 bg-white p-2 font-mono text-xs leading-5 text-slate-700 focus:outline-2 focus:outline-offset-2 focus:outline-blue-700"
          onFocus={(event) => event.currentTarget.select()}
          readOnly
          value={fallback}
        />
      ) : null}
    </span>
  );
}
