import { CopyCodeButton } from "./copy-code-button";
import { formatBytes } from "./demo-list";
import type { ProjectAccessState } from "./password-access-manager";

export interface ProjectFile {
  relativePath: string;
  size: number;
  url: string;
}

export function ProjectFiles({
  files,
  access,
  query,
  onQueryChange,
}: {
  files: ProjectFile[];
  access: ProjectAccessState;
  query: string;
  onQueryChange: (value: string) => void;
}) {
  const normalizedQuery = query.trim().toLowerCase();
  const visibleFiles =
    normalizedQuery.length === 0
      ? files
      : files.filter((file) => file.relativePath.toLowerCase().includes(normalizedQuery));

  return (
    <section aria-labelledby="project-files-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="section-title" id="project-files-title">
            全部文件（{files.length}）
          </h2>
          {files.length > 0 ? (
            <p aria-live="polite" className="mt-1 text-xs text-slate-500">
              显示 {visibleFiles.length} / {files.length} 个文件
            </p>
          ) : null}
        </div>
        {files.length > 0 ? (
          <label className="w-full sm:w-72">
            <span className="sr-only">搜索文件名</span>
            <input
              autoComplete="off"
              className="field"
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="搜索文件名或目录"
              type="search"
              value={query}
            />
          </label>
        ) : null}
      </div>
      {files.length === 0 ? (
        <p className="mt-4 rounded-xl bg-slate-50 p-5 text-sm text-slate-600">
          当前项目暂无已发布文件。
        </p>
      ) : visibleFiles.length === 0 ? (
        <div className="mt-3 rounded-xl bg-slate-50 px-4 py-5 text-sm text-slate-600">
          <p>没有匹配的文件。</p>
          <button
            className="mt-2 min-h-10 md:min-h-9 font-semibold text-blue-700 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
            onClick={() => onQueryChange("")}
            type="button"
          >
            清空搜索
          </button>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {visibleFiles.map((file) => (
            <li className="min-w-0 px-3 py-2.5" key={file.url}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h3 className="min-w-0 break-all font-mono text-sm font-medium">
                  {file.relativePath}
                </h3>
                <span className="shrink-0 text-xs text-slate-500">{formatBytes(file.size)}</span>
              </div>
              <div className="mt-1 grid min-w-0 gap-1.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <a
                  className="flex min-h-10 min-w-0 items-center select-text break-all md:block md:min-h-0 font-mono text-xs leading-5 text-slate-600 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-blue-700"
                  href={file.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {file.url}
                </a>
                <CopyCodeButton
                  compact
                  {...(access.accessMode === "password" && access.passwordStatus !== "available"
                    ? { disabledReason: "请先重新生成密码" }
                    : {})}
                  failureValue={shareText(file.url, access)}
                  label="复制链接"
                  successMessage="已复制分享信息"
                  value={shareText(file.url, access)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function shareText(url: string, access: ProjectAccessState) {
  return access.accessMode === "password" && access.accessPassword !== undefined
    ? `链接：${url}\n密码：${access.accessPassword}`
    : url;
}
