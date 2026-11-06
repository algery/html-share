"use client";

import type { DirectoryDepartment, DirectoryUser, SquareDraft } from "../lib/square-types";
import { SquareDirectoryBrowser } from "./square-directory-browser";

export function SquareAudiencePicker({
  apiUrl,
  draft,
  disabled,
  onChange,
}: {
  apiUrl: string;
  draft: SquareDraft;
  disabled: boolean;
  onChange: (draft: SquareDraft) => void;
}) {
  function toggleDepartment(item: DirectoryDepartment) {
    const exists = draft.departments.some((value) => value.id === item.id);
    if (!exists && draft.departments.length + draft.users.length >= 100) return;
    onChange({
      ...draft,
      departments: exists
        ? draft.departments.filter((value) => value.id !== item.id)
        : [...draft.departments, item],
    });
  }
  function toggleUser(item: DirectoryUser) {
    const exists = draft.users.some((value) => value.id === item.id);
    if (!exists && draft.departments.length + draft.users.length >= 100) return;
    onChange({
      ...draft,
      users: exists ? draft.users.filter((value) => value.id !== item.id) : [...draft.users, item],
    });
  }
  const count = draft.departments.length + draft.users.length;
  return (
    <fieldset className="mt-4 min-w-0" disabled={disabled}>
      <legend className="text-sm font-semibold">选择可见范围</legend>
      <label className="flex min-h-10 items-center gap-2 text-sm">
        <input
          checked={draft.audienceType === "organization"}
          name="square-audience"
          onChange={() => onChange({ ...draft, audienceType: "organization" })}
          type="radio"
        />
        全组织
      </label>
      <label className="flex min-h-10 items-center gap-2 text-sm">
        <input
          checked={draft.audienceType === "selected"}
          name="square-audience"
          onChange={() => onChange({ ...draft, audienceType: "selected" })}
          type="radio"
        />
        指定部门 / 人员
      </label>
      {draft.audienceType === "selected" ? (
        <>
          <p className="text-xs leading-5 text-slate-500">
            部门包含子部门；命中任一所选部门或人员即可见。合计最多 100 项。
          </p>
          <SquareDirectoryBrowser
            apiUrl={apiUrl}
            disabled={disabled}
            draft={draft}
            onDepartment={toggleDepartment}
            onUser={toggleUser}
          />
          <section aria-label="已选范围" className="mt-3 min-w-0">
            <h3 className="text-xs font-semibold text-slate-600">已选 {count} / 100 项</h3>
            {count === 0 ? (
              <p className="mt-2 text-xs text-slate-500">请至少选择一个部门或人员。</p>
            ) : null}
            {count >= 100 ? (
              <p className="mt-2 text-xs text-amber-800" role="status">
                已达 100 项上限，请先移除已选对象。
              </p>
            ) : null}
            <ul className="mt-2 space-y-2">
              {draft.departments.map((item) => (
                <SelectedItem
                  key={`department:${item.id}`}
                  label={`部门：${item.name}`}
                  path={item.path}
                  disabled={disabled}
                  onRemove={() => toggleDepartment(item)}
                />
              ))}
              {draft.users.map((item) => (
                <SelectedItem
                  key={`user:${item.id}`}
                  label={`人员：${item.name}`}
                  path={item.departmentPaths.join("、") || "暂无部门信息"}
                  disabled={disabled}
                  onRemove={() => toggleUser(item)}
                />
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </fieldset>
  );
}

function SelectedItem({
  label,
  path,
  disabled,
  onRemove,
}: {
  label: string;
  path: string;
  disabled: boolean;
  onRemove: () => void;
}) {
  return (
    <li className="flex min-w-0 items-center gap-2 rounded-md bg-slate-50 px-2">
      <span className="min-w-0 flex-1 py-2 text-xs">
        <span className="block break-words font-medium">{label}</span>
        <span className="mt-1 block break-all text-slate-500">{path}</span>
      </span>
      <button
        aria-label={`移除${label}`}
        className="min-h-10 min-w-10 shrink-0 px-1 text-xs font-semibold text-blue-700 focus-visible:outline-2 focus-visible:outline-blue-700"
        disabled={disabled}
        onClick={onRemove}
        type="button"
      >
        移除
      </button>
    </li>
  );
}
