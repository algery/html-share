"use client";

import { useState } from "react";

interface CopyCodeButtonProps {
  compact?: boolean;
  disabledReason?: string;
  failureValue?: string;
  label?: string;
  successMessage?: string;
  value: string;
}

export function CopyCodeButton({
  compact = false,
  disabledReason,
  failureValue,
  label = "复制配置",
  successMessage = "已复制",
  value,
}: CopyCodeButtonProps) {
  const [message, setMessage] = useState<string | null>(null);
  const [showFallback, setShowFallback] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(successMessage);
      setShowFallback(false);
    } catch {
      setMessage("复制失败，请手动复制");
      setShowFallback(true);
    }
  }

  return (
    <span className={`${compact ? "mt-0 shrink-0" : "mt-2"} inline-grid max-w-full gap-2`}>
      <span className="inline-flex items-center gap-2">
        <button
          className={`${compact ? "min-h-8 px-2.5" : "min-h-9 px-3"} rounded-md border border-slate-300 bg-white text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700`}
          disabled={disabledReason !== undefined}
          onClick={() => void copy()}
          type="button"
        >
          {label}
        </button>
        <span aria-live="polite" className="text-xs text-slate-600">
          {disabledReason ?? message}
        </span>
      </span>
      {showFallback ? (
        <textarea
          aria-label="手动复制内容"
          className="min-h-20 w-full resize-y rounded-md border border-slate-300 bg-white p-2 font-mono text-xs leading-5 text-slate-700 focus:outline-2 focus:outline-offset-2 focus:outline-blue-700"
          onFocus={(event) => event.currentTarget.select()}
          readOnly
          value={failureValue ?? value}
        />
      ) : null}
    </span>
  );
}
