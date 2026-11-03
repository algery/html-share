"use client";

import Link from "next/link";
import { CopyCodeButton } from "./copy-code-button";
import { CopyProjectShareButton } from "./copy-project-share-button";
import type { DemoSummary } from "./demo-list";

export interface DemoHomepage {
  configuredPath: string | null;
  path: string | null;
  source: "manual" | "automatic" | "missing" | "ambiguous" | "none";
  url: string | null;
}

export function DemoHomepageLink({ demo, apiUrl }: { demo: DemoSummary; apiUrl: string }) {
  const homepage = demo.homepage;
  if (!homepage?.url)
    return (
      <div className="text-xs leading-5">
        <p className="text-slate-500">
          {homepage?.source === "missing"
            ? "原首页已移除"
            : homepage?.source === "none"
              ? "暂无 HTML 文件"
              : "尚未指定首页"}
        </p>
        <Link
          className="inline-flex min-h-8 items-center font-semibold text-blue-700 hover:underline"
          href={`/demos/${demo.projectId}#project-homepage`}
        >
          设置首页
        </Link>
      </div>
    );
  return (
    <div className="min-w-0">
      <a
        className="block truncate font-mono text-xs text-blue-700 underline-offset-4 hover:underline"
        href={homepage.url}
        title={homepage.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        {homepage.path}
      </a>
      {demo.accessMode === "password" ? (
        <CopyProjectShareButton apiUrl={apiUrl} projectId={demo.projectId} url={homepage.url} />
      ) : (
        <CopyCodeButton compact label="复制首页" value={homepage.url} />
      )}
    </div>
  );
}
