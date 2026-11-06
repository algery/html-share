"use client";

import { useState } from "react";
import Link from "next/link";

import { DemoHomepageLink, DemoShareAction, type DemoHomepage } from "./demo-homepage-link";
import { DeleteEntry } from "./demo-delete-dialog";
import { AccessModeBadge } from "./access-mode-badge";

export interface DemoSummary {
  accessMode: "organization" | "password";
  squareEnabled?: boolean;
  createdAt: string;
  displayName: string;
  fileCount: number;
  projectId: string;
  projectPrefix: string;
  homepage?: DemoHomepage;
  totalSize: number;
  updatedAt: string;
}

interface DemoListProps {
  apiUrl: string;
  csrfToken: string | null;
  demos: DemoSummary[];
  onDeleted: () => Promise<void>;
}

export function DemoList({ apiUrl, csrfToken, demos, onDeleted }: DemoListProps) {
  const [deleteTarget, setDeleteTarget] = useState<DemoSummary | null>(null);
  return (
    <>
      <div className="table-shell hidden md:block">
        <table className="data-table demo-table min-w-[1008px] table-fixed">
          <colgroup>
            <col />
            <col className="w-[160px] xl:w-[180px]" />
            <col className="w-[100px]" />
            <col className="w-[92px] xl:w-[100px]" />
            <col className="w-[188px] xl:w-[200px]" />
            <col className="w-[160px]" />
            <col className="w-[64px]" />
          </colgroup>
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <Header>名称</Header>
              <Header>首页链接</Header>
              <Header>访问方式</Header>
              <Header>文件 / 大小</Header>
              <Header>时间</Header>
              <Header>分享</Header>
              <th className="px-3 py-3 font-medium">
                <span className="sr-only">操作</span>
              </th>
            </tr>
          </thead>
          <tbody className="bg-white">
            {demos.map((demo) => (
              <DemoRow
                apiUrl={apiUrl}
                demo={demo}
                key={demo.projectId}
                onDelete={setDeleteTarget}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 md:hidden">
        {demos.map((demo) => (
          <DemoCard apiUrl={apiUrl} demo={demo} key={demo.projectId} onDelete={setDeleteTarget} />
        ))}
      </div>
      {deleteTarget === null ? null : (
        <DeleteEntry
          apiUrl={apiUrl}
          csrfToken={csrfToken}
          demo={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={onDeleted}
        />
      )}
    </>
  );
}

function Header({ children }: { children: string }) {
  return <th className="whitespace-nowrap px-4 py-3 font-medium">{children}</th>;
}

function DemoRow({
  demo,
  onDelete,
  apiUrl,
}: {
  demo: DemoSummary;
  onDelete: (demo: DemoSummary) => void;
  apiUrl: string;
}) {
  return (
    <tr>
      <td className="min-w-60 px-3 py-3 font-medium">
        <div className="truncate">
          <DemoName demo={demo} />
        </div>
        <p className="mt-0.5 font-mono text-xs text-slate-500">{demo.projectId}</p>
      </td>
      <td className="px-3 py-3">
        <DemoHomepageLink demo={demo} />
      </td>
      <td className="px-1 py-3">
        <AccessModeBadge mode={demo.accessMode} />
        <DemoSquareStatus demo={demo} />
      </td>
      <td className="px-3 py-3 whitespace-nowrap text-xs leading-5">
        <p>{demo.fileCount} 个文件</p>
        <p className="text-slate-500">{formatBytes(demo.totalSize)}</p>
      </td>
      <td className="px-3 py-3 whitespace-nowrap text-xs leading-5">
        <p>
          <span className="text-slate-500">更新 </span>
          {formatDate(demo.updatedAt)}
        </p>
        <p className="text-slate-500">创建 {formatDate(demo.createdAt)}</p>
      </td>
      <td className="share-cell px-3 py-3">
        <DemoShareAction apiUrl={apiUrl} demo={demo} />
      </td>
      <td className="px-3 py-3">
        <DeleteButton demo={demo} onDelete={onDelete} />
      </td>
    </tr>
  );
}

function DemoCard({
  apiUrl,
  demo,
  onDelete,
}: {
  apiUrl: string;
  demo: DemoSummary;
  onDelete: (demo: DemoSummary) => void;
}) {
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words font-semibold">
            <DemoName demo={demo} />
          </h3>
          <p className="mt-0.5 font-mono text-xs text-slate-500">{demo.projectId}</p>
        </div>
        <DeleteButton demo={demo} onDelete={onDelete} />
      </div>
      <div className="mt-3 flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <DemoHomepageLink demo={demo} />
        </div>
        <AccessModeBadge mode={demo.accessMode} />
      </div>
      <DemoSquareStatus demo={demo} />
      <p className="mt-2 text-xs text-slate-500">
        {demo.fileCount} 个文件 · {formatBytes(demo.totalSize)}
      </p>
      <dl className="mt-2 grid gap-0.5 text-xs text-slate-500">
        <div className="flex gap-2">
          <dt>更新</dt>
          <dd>{formatDate(demo.updatedAt)}</dd>
        </div>
        <div className="flex gap-2">
          <dt>创建</dt>
          <dd>{formatDate(demo.createdAt)}</dd>
        </div>
      </dl>
      <div className="mt-3 border-t border-slate-200 pt-3">
        <DemoShareAction apiUrl={apiUrl} demo={demo} />
      </div>
    </article>
  );
}

function DemoName({ demo }: { demo: DemoSummary }) {
  return (
    <Link
      className="inline-flex min-h-10 max-w-full items-center text-slate-950 underline-offset-4 md:inline md:min-h-0 hover:text-blue-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700"
      title={demo.displayName}
      href={`/demos/${demo.projectId}`}
    >
      {demo.displayName}
    </Link>
  );
}

function DeleteButton({
  demo,
  onDelete,
}: {
  demo: DemoSummary;
  onDelete: (demo: DemoSummary) => void;
}) {
  return (
    <button
      className="min-h-10 min-w-10 text-xs font-medium text-rose-700 hover:text-rose-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700"
      onClick={() => onDelete(demo)}
      type="button"
    >
      删除
    </button>
  );
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(
    new Date(value),
  );
}

function DemoSquareStatus({ demo }: { demo: DemoSummary }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1 text-xs leading-4">
      <span className={demo.squareEnabled ? "text-emerald-700" : "text-slate-500"}>
        {demo.squareEnabled ? "已共享" : "未共享"}
      </span>
      <Link
        className="inline-flex min-h-10 items-center text-blue-700 hover:underline focus-visible:outline-2 focus-visible:outline-blue-700 md:min-h-6"
        href={`/demos/${demo.projectId}#project-square`}
      >
        广场设置
      </Link>
    </div>
  );
}
