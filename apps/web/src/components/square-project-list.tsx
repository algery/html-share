import Link from "next/link";
import type { SquareProject } from "../lib/square-types";
import { formatDate } from "./demo-list";
import { ManagementIcon } from "./management-icon";

export function SquareProjectList({ projects }: { projects: SquareProject[] }) {
  return (
    <>
      <div className="table-shell hidden md:block">
        <table className="data-table min-w-[820px] table-fixed">
          <colgroup>
            <col />
            <col className="w-40" />
            <col className="w-44" />
            <col className="w-64" />
          </colgroup>
          <thead>
            <tr>
              {["名称", "创建者", "内容更新时间", "查看"].map((label) => (
                <th className="px-4 py-3" key={label}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.projectId}>
                <td className="min-w-60 px-4 py-3">
                  <Link
                    className="block truncate font-medium text-slate-950 hover:text-blue-700 focus-visible:outline-2 focus-visible:outline-blue-700"
                    href={`/square/${encodeURIComponent(project.projectId)}`}
                    title={project.displayName}
                  >
                    {project.displayName}
                  </Link>
                </td>
                <td className="break-words px-4 py-3 text-sm text-slate-600">
                  {project.creatorDisplayName}
                </td>
                <td className="px-4 py-3 text-xs text-slate-500">
                  {formatDate(project.updatedAt)}
                </td>
                <td className="px-4 py-2">
                  <SquareProjectActions project={project} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 md:hidden">
        {projects.map((project) => (
          <article
            className="min-w-0 rounded-lg border border-slate-200 bg-white p-4"
            key={project.projectId}
          >
            <h2 className="break-words font-semibold">
              <Link
                className="inline-flex min-h-10 items-center hover:text-blue-700 focus-visible:outline-2 focus-visible:outline-blue-700"
                href={`/square/${encodeURIComponent(project.projectId)}`}
              >
                {project.displayName}
              </Link>
            </h2>
            <p className="mt-1 break-words text-xs text-slate-500">
              创建者 {project.creatorDisplayName}
            </p>
            <p className="mt-2 text-xs text-slate-500">内容更新 {formatDate(project.updatedAt)}</p>
            <div className="mt-3 border-t border-slate-200 pt-3">
              <SquareProjectActions project={project} />
            </div>
          </article>
        ))}
      </div>
    </>
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
