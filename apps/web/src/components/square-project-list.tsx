import Link from "next/link";
import type { SquareProject } from "../lib/square-types";
import { formatDate } from "./demo-list";
import { ManagementIcon } from "./management-icon";
import { SquareProjectCover } from "./square-project-cover";

export function SquareProjectList({
  apiUrl,
  projects,
}: {
  apiUrl: string;
  projects: SquareProject[];
}) {
  return (
    <div aria-label="项目卡片" className="square-cover-columns" role="list">
      {projects.map((project) => (
        <div className="square-cover-item" key={project.projectId} role="listitem">
          <article className="min-w-0 rounded-lg border border-slate-200 bg-white">
            <SquareProjectCover apiUrl={apiUrl} project={project} />
            <div className="p-4">
              <h2 className="wrap-anywhere font-semibold">
                <Link
                  className="inline-flex min-h-10 items-center hover:text-blue-700 focus-visible:outline-2 focus-visible:outline-blue-700"
                  href={`/square/${encodeURIComponent(project.projectId)}`}
                >
                  {project.displayName}
                </Link>
              </h2>
              <p className="mt-1 wrap-anywhere text-xs text-slate-500">
                创建者 {project.creatorDisplayName}
              </p>
              <p className="mt-2 text-xs text-slate-500">
                内容更新 {formatDate(project.updatedAt)}
              </p>
              <div className="mt-3 border-t border-slate-200 pt-3">
                <SquareProjectActions project={project} />
              </div>
            </div>
          </article>
        </div>
      ))}
    </div>
  );
}

function SquareProjectActions({ project }: { project: SquareProject }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {project.homepage?.url ? (
        <a
          className="button-primary"
          href={project.homepage.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          查看内容
          <ManagementIcon name="arrow" />
        </a>
      ) : (
        <p className="w-full text-xs text-slate-500">从项目内容选择文件</p>
      )}
      <Link
        className="inline-flex min-h-10 items-center text-sm font-semibold text-blue-700 hover:underline focus-visible:outline-2 focus-visible:outline-blue-700"
        href={`/square/${encodeURIComponent(project.projectId)}`}
      >
        项目内容
      </Link>
    </div>
  );
}
