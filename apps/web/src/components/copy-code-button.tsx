"use client";

import { useState } from "react";

interface CopyCodeButtonProps {
  label?: string;
  value: string;
}

export function CopyCodeButton({ label = "复制配置", value }: CopyCodeButtonProps) {
  const [message, setMessage] = useState<string | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setMessage("已复制");
    } catch {
      setMessage("复制失败，请手动复制");
    }
  }

  return (
    <span className="mt-2 inline-flex items-center gap-2">
      <button
        className="min-h-9 rounded-md border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
        onClick={() => void copy()}
        type="button"
      >
        {label}
      </button>
      <span aria-live="polite" className="text-xs text-slate-600">
        {message}
      </span>
    </span>
  );
}
