"use client";

import { useState } from "react";
import type {
  DirectoryDepartment,
  DirectoryItem,
  DirectoryUser,
  SquareDraft,
} from "../lib/square-types";
import { useDirectoryPage } from "./use-directory-page";

export interface DirectorySelectionProps {
  draft: SquareDraft;
  disabled: boolean;
  onDepartment: (item: DirectoryDepartment) => void;
  onUser: (item: DirectoryUser) => void;
}

export function SquareDirectoryBrowser({
  apiUrl,
  ...selection
}: DirectorySelectionProps & { apiUrl: string }) {
  const [query, setQuery] = useState("");
  const keyword = query.trim();
  return (
    <div className="mt-3 min-w-0">
      <label className="block text-xs font-medium text-slate-600">
        搜索部门或姓名
        <input
          autoComplete="off"
          className="field mt-1"
          disabled={selection.disabled}
          maxLength={80}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="输入部门或姓名"
          type="search"
          value={query}
        />
      </label>
      <div className="mt-3 max-h-80 overflow-y-auto rounded-lg border border-slate-200 p-2">
        {keyword ? (
          <SearchResults apiUrl={apiUrl} keyword={keyword} key={keyword} {...selection} />
        ) : (
          <DirectoryBranch apiUrl={apiUrl} parentId={null} {...selection} />
        )}
      </div>
    </div>
  );
}

function DirectoryBranch({
  apiUrl,
  parentId,
  ...selection
}: DirectorySelectionProps & { apiUrl: string; parentId: string | null }) {
  const endpoint = `${apiUrl}/api/directory/departments?limit=20${parentId === null ? "" : `&parentId=${encodeURIComponent(parentId)}`}`;
  const request = useDirectoryPage<DirectoryDepartment>(endpoint);
  return (
    <div>
      {request.status !== "error"
        ? request.data.items.map((item) => (
            <DepartmentNode key={item.id} apiUrl={apiUrl} item={item} {...selection} />
          ))
        : null}
      {request.status === "ready" && request.data.items.length === 0 ? (
        <p className="p-2 text-xs text-slate-500">当前层级没有可选部门，可按姓名搜索人员。</p>
      ) : null}
      <DirectoryFeedback {...request} />
    </div>
  );
}

function DepartmentNode({
  apiUrl,
  item,
  ...selection
}: DirectorySelectionProps & { apiUrl: string; item: DirectoryDepartment }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <div className="flex min-w-0 items-start gap-1">
        {item.hasChildren ? (
          <button
            aria-expanded={expanded}
            aria-label={`${expanded ? "收起" : "展开"}${item.name}`}
            className="min-h-10 min-w-10 shrink-0 text-slate-600 focus-visible:outline-2 focus-visible:outline-blue-700"
            disabled={selection.disabled}
            onClick={() => setExpanded(!expanded)}
            type="button"
          >
            {expanded ? "−" : "+"}
          </button>
        ) : null}
        <DirectoryChoice item={{ ...item, kind: "department" }} {...selection} />
      </div>
      {expanded ? (
        <div className="ml-3 border-l border-slate-200 pl-2">
          <DirectoryBranch apiUrl={apiUrl} parentId={item.id} {...selection} />
        </div>
      ) : null}
    </div>
  );
}

function SearchResults({
  apiUrl,
  keyword,
  ...selection
}: DirectorySelectionProps & { apiUrl: string; keyword: string }) {
  const request = useDirectoryPage<DirectoryItem>(
    `${apiUrl}/api/directory/search?q=${encodeURIComponent(keyword)}&kind=all&limit=20`,
  );
  return (
    <div>
      {request.status !== "error"
        ? request.data.items.map((item) => (
            <DirectoryChoice key={`${item.kind}:${item.id}`} item={item} {...selection} />
          ))
        : null}
      {request.status === "ready" && request.data.items.length === 0 ? (
        <p className="p-2 text-xs text-slate-500">没有匹配的部门或人员。</p>
      ) : null}
      <DirectoryFeedback {...request} />
    </div>
  );
}

function DirectoryChoice({
  item,
  draft,
  disabled,
  onDepartment,
  onUser,
}: DirectorySelectionProps & { item: DirectoryItem }) {
  const selected =
    item.kind === "department"
      ? draft.departments.some((value) => value.id === item.id)
      : draft.users.some((value) => value.id === item.id);
  const atLimit = draft.departments.length + draft.users.length >= 100;
  return (
    <label className="flex min-h-10 min-w-0 flex-1 cursor-pointer items-start gap-2 rounded px-1 py-2 hover:bg-slate-50">
      <input
        className="mt-1 shrink-0 accent-blue-700"
        type="checkbox"
        checked={selected}
        disabled={disabled || (!selected && atLimit)}
        onChange={() => (item.kind === "department" ? onDepartment(item) : onUser(item))}
      />
      <span className="min-w-0 break-words text-sm">
        <span>
          {item.name}
          {item.kind === "department" ? "（含子部门）" : ""}
        </span>
        <span className="mt-0.5 block break-all text-xs leading-5 text-slate-500">
          {item.kind === "department"
            ? item.path
            : item.departmentPaths.join("、") || "暂无部门信息"}
        </span>
      </span>
    </label>
  );
}

function DirectoryFeedback({
  data,
  status,
  message,
  retry,
  loadMore,
}: {
  data: { limited: boolean; nextCursor: string | null };
  status: "loading" | "ready" | "error";
  message: string;
  retry: () => void;
  loadMore: () => void;
}) {
  return (
    <>
      {data.limited ? (
        <p className="p-2 text-xs leading-5 text-amber-800" role="status">
          仅显示应用获授权的部门和人员，目录范围不完整。
        </p>
      ) : null}
      {status === "loading" ? (
        <div className="p-2 text-xs text-slate-500" role="status">
          <p>正在加载目录…</p>
          <div aria-hidden="true" className="mt-2 space-y-2 motion-safe:animate-pulse">
            <div className="h-3 w-3/4 rounded bg-slate-200" />
            <div className="h-3 w-1/2 rounded bg-slate-200" />
          </div>
        </div>
      ) : null}
      {status === "error" ? (
        <div className="p-2 text-xs leading-5 text-rose-700" role="alert">
          <p>{message}</p>
          <button className="button-secondary mt-2" onClick={retry} type="button">
            重试目录
          </button>
        </div>
      ) : null}
      {status === "ready" && data.nextCursor !== null ? (
        <button className="button-secondary mt-2" onClick={loadMore} type="button">
          继续加载
        </button>
      ) : null}
    </>
  );
}
