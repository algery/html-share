"use client";

import { useState } from "react";
import Link from "next/link";

import { DemoHomepageLink, type DemoHomepage } from "./demo-homepage-link";
import { DeleteEntry } from "./demo-delete-dialog";
import { AccessModeBadge } from "./access-mode-badge";

export interface DemoSummary {
  accessMode: "organization" | "password";
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
      <div className="hidden overflow-x-auto rounded-xl border border-slate-200 md:block">
        <table className="w-full min-w-[920px] table-fixed divide-y divide-slate-200 text-left text-sm">
          <colgroup>
            <col className="w-[240px]" />
            <col className="w-[180px]" />
            <col className="w-[100px]" />
            <col className="w-[64px]" />
            <col className="w-[72px]" />
            <col className="w-[200px]" />
            <col className="w-[64px]" />
          </colgroup>
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <Header>名称</Header>
              <Header>首页链接</Header>
              <Header>访问方式</Header>
              <Header>文件</Header>
              <Header>大小</Header>
              <Header>时间</Header>
              <th className="sticky right-0 bg-slate-50 px-4 py-3 font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 bg-white">
            {demos.map((demo) => (
              <DemoRow demo={demo} key={demo.projectId} onDelete={setDeleteTarget} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 md:hidden">
        {demos.map((demo) => (
          <DemoCard demo={demo} key={demo.projectId} onDelete={setDeleteTarget} />
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

function DemoRow({ demo, onDelete }: { demo: DemoSummary; onDelete: (demo: DemoSummary) => void }) {
  return (
    <tr>
      <td className="min-w-60 px-4 py-3 font-medium">
        <div className="truncate">
          <DemoName demo={demo} />
        </div>
        <p className="mt-1 font-mono text-xs text-slate-500">{demo.projectId}</p>
      </td>
      <td className="px-4 py-3">
        <DemoHomepageLink demo={demo} />
      </td>
      <td className="px-4 py-3">
        <AccessModeBadge mode={demo.accessMode} />
      </td>
      <td className="px-4 py-3">{demo.fileCount}</td>
      <td className="px-4 py-3 whitespace-nowrap">{formatBytes(demo.totalSize)}</td>
      <td className="px-4 py-3 whitespace-nowrap text-xs leading-5">
        <p>
          <span className="text-slate-500">更新 </span>
          {formatDate(demo.updatedAt)}
        </p>
        <p className="text-slate-500">创建 {formatDate(demo.createdAt)}</p>
      </td>
      <td className="sticky right-0 bg-white px-4 py-3">
        <DeleteButton demo={demo} onDelete={onDelete} />
      </td>
    </tr>
  );
}

function DemoCard({
  demo,
  onDelete,
}: {
  demo: DemoSummary;
  onDelete: (demo: DemoSummary) => void;
}) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 break-all font-semibold">
          <DemoName demo={demo} />
        </h3>
        <DeleteButton demo={demo} onDelete={onDelete} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <Detail label="项目标识" value={demo.projectId} />
        <Detail label="文件数" value={String(demo.fileCount)} />
        <div>
          <dt className="text-slate-500">访问方式</dt>
          <dd className="mt-1">
            <AccessModeBadge mode={demo.accessMode} />
          </dd>
        </div>
        <Detail label="总大小" value={formatBytes(demo.totalSize)} />
        <Detail label="创建时间" value={formatDate(demo.createdAt)} />
        <Detail label="更新时间" value={formatDate(demo.updatedAt)} />
        <div className="col-span-2">
          <dt className="text-slate-500">首页链接</dt>
          <dd className="mt-1">
            <DemoHomepageLink demo={demo} />
          </dd>
        </div>
      </dl>
    </article>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="mt-1 break-all font-medium">{value}</dd>
    </div>
  );
}

function DemoName({ demo }: { demo: DemoSummary }) {
  return (
    <Link
      className="text-blue-700 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700"
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
      className="min-h-10 font-semibold text-rose-700 hover:text-rose-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700"
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
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
