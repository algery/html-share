"use client";

import { useState } from "react";

import { CopyCodeButton } from "./copy-code-button";

export interface DemoSummary {
  createdAt: string;
  displayName: string;
  fileCount: number;
  projectId: string;
  projectPrefix: string;
  totalSize: number;
  updatedAt: string;
}

interface DemoListProps {
  demos: DemoSummary[];
}

export function DemoList({ demos }: DemoListProps) {
  const [deleteTarget, setDeleteTarget] = useState<DemoSummary | null>(null);
  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border border-slate-200 md:block">
        <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <Header>名称</Header>
              <Header>项目标识</Header>
              <Header>项目前缀</Header>
              <Header>文件</Header>
              <Header>大小</Header>
              <Header>创建时间</Header>
              <Header>更新时间</Header>
              <Header>操作</Header>
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
        <DeleteEntry demo={deleteTarget} onClose={() => setDeleteTarget(null)} />
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
      <td className="px-4 py-3 font-medium">{demo.displayName}</td>
      <td className="px-4 py-3 font-mono">{demo.projectId}</td>
      <td className="max-w-48 px-4 py-3">
        <Prefix value={demo.projectPrefix} />
      </td>
      <td className="px-4 py-3">{demo.fileCount}</td>
      <td className="px-4 py-3 whitespace-nowrap">{formatBytes(demo.totalSize)}</td>
      <td className="px-4 py-3 whitespace-nowrap">{formatDate(demo.createdAt)}</td>
      <td className="px-4 py-3 whitespace-nowrap">{formatDate(demo.updatedAt)}</td>
      <td className="px-4 py-3">
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
        <h3 className="font-semibold">{demo.displayName}</h3>
        <DeleteButton demo={demo} onDelete={onDelete} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <Detail label="项目标识" value={demo.projectId} />
        <Detail label="文件数" value={String(demo.fileCount)} />
        <Detail label="总大小" value={formatBytes(demo.totalSize)} />
        <Detail label="创建时间" value={formatDate(demo.createdAt)} />
        <Detail label="更新时间" value={formatDate(demo.updatedAt)} />
        <div className="col-span-2">
          <dt className="text-slate-500">项目前缀</dt>
          <dd className="mt-1">
            <Prefix value={demo.projectPrefix} />
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

function Prefix({ value }: { value: string }) {
  return (
    <div className="min-w-0">
      <code className="block truncate text-xs text-slate-700" title={value}>
        {value}
      </code>
      <CopyCodeButton label="复制前缀" value={value} />
    </div>
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

function DeleteEntry({ demo, onClose }: { demo: DemoSummary; onClose: () => void }) {
  return (
    <div
      aria-labelledby="delete-entry-title"
      aria-modal="true"
      className="fixed inset-0 z-10 flex items-end bg-slate-950/40 p-4 sm:items-center sm:justify-center"
      role="dialog"
    >
      <section className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold" id="delete-entry-title">
          删除 Demo
        </h2>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          将删除「{demo.displayName}」（项目标识：<code>{demo.projectId}</code>
          ）。删除执行、立即失效和不可恢复确认将在 Phase 8 提供；当前不会发送删除请求。
        </p>
        <button
          autoFocus
          className="mt-6 min-h-11 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700"
          onClick={onClose}
          type="button"
        >
          知道了
        </button>
      </section>
    </div>
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
