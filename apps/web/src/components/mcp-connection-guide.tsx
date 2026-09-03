"use client";

import { useId, useState } from "react";

import { InstallGuide } from "../app/tokens/install-guide";

export function McpConnectionGuide({ apiUrl, mcpUrl }: { apiUrl: string; mcpUrl: string }) {
  const [host, setHost] = useState<"claude" | "codex">("codex");
  const panelId = useId();
  return (
    <section className="mt-4">
      <div aria-label="选择 Agent 宿主" role="tablist" className="flex gap-2">
        <Tab
          active={host === "codex"}
          label="Codex"
          onClick={() => setHost("codex")}
          panelId={panelId}
        />
        <Tab
          active={host === "claude"}
          label="Claude Code"
          onClick={() => setHost("claude")}
          panelId={panelId}
        />
      </div>
      <div id={panelId} role="tabpanel" className="mt-2">
        <InstallGuide apiUrl={apiUrl} host={host} mcpUrl={mcpUrl} />
      </div>
    </section>
  );
}

function Tab({
  active,
  label,
  onClick,
  panelId,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  panelId: string;
}) {
  return (
    <button
      aria-controls={panelId}
      aria-selected={active}
      className={`min-h-10 rounded-md px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 ${active ? "bg-blue-700 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}
      onClick={onClick}
      role="tab"
      type="button"
    >
      {label}
    </button>
  );
}
