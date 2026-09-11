"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { CopyCodeButton } from "./copy-code-button";
import {
  PasswordAccessConfirmDialog,
  type PasswordAccessAction,
} from "./password-access-confirm-dialog";

export interface ProjectAccessState {
  accessMode: "organization" | "password";
  accessPassword?: string;
  passwordStatus: "available" | "disabled" | "unavailable";
}

const secondaryButton =
  "min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700 disabled:cursor-not-allowed disabled:text-slate-400";

export function PasswordAccessManager({
  access,
  apiUrl,
  csrfToken,
  onChanged,
  projectId,
}: {
  access: ProjectAccessState;
  apiUrl: string;
  csrfToken: string | null;
  onChanged: (access: ProjectAccessState) => void;
  projectId: string;
}) {
  const [confirmation, setConfirmation] = useState<PasswordAccessAction | null>(null);
  const [error, setError] = useState<{ login?: boolean; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const confirmationTriggerRef = useRef<HTMLButtonElement | null>(null);

  function openConfirmation(action: PasswordAccessAction, trigger: HTMLButtonElement) {
    confirmationTriggerRef.current = trigger;
    setConfirmation(action);
  }

  function closeConfirmation() {
    setConfirmation(null);
    requestAnimationFrame(() => {
      const trigger = confirmationTriggerRef.current;
      if (trigger?.isConnected) trigger.focus();
      else sectionRef.current?.focus();
    });
  }

  useEffect(() => {
    if (confirmation === null) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) closeConfirmation();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [confirmation, submitting]);

  async function submit(action: PasswordAccessAction) {
    if (submitting) return;
    if (csrfToken === null) {
      setError({ login: true, message: "安全校验已过期，请重新登录后再试。" });
      return;
    }
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`${apiUrl}/api/projects/${projectId}/password-access`, {
        body: JSON.stringify({ action }),
        credentials: "include",
        headers: { "content-type": "application/json", "x-html-share-csrf": csrfToken },
        method: "POST",
      });
      const body = (await response.json()) as ProjectAccessState & { error?: string };
      if (!response.ok) throw new ManagementRequestError(response.status, body.error);
      onChanged({
        accessMode: body.accessMode,
        ...(body.accessPassword === undefined ? {} : { accessPassword: body.accessPassword }),
        passwordStatus: body.passwordStatus,
      });
      closeConfirmation();
      setNotice(successMessage(action));
    } catch (caught) {
      setError(errorMessage(caught));
      closeConfirmation();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      aria-labelledby="access-title"
      className="mt-7 rounded-xl border border-slate-200 p-4"
      ref={sectionRef}
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-semibold" id="access-title">
            访问方式
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {access.accessMode === "password" ? "密码访问" : "组织访问"}
          </p>
        </div>
        {access.accessMode === "organization" ? (
          <button
            className={secondaryButton}
            onClick={(event) => openConfirmation("enable", event.currentTarget)}
            type="button"
          >
            开启密码访问
          </button>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              className={secondaryButton}
              onClick={(event) => openConfirmation("regenerate", event.currentTarget)}
              type="button"
            >
              重新生成密码
            </button>
            <button
              className={`${secondaryButton} text-rose-700`}
              onClick={(event) => openConfirmation("disable", event.currentTarget)}
              type="button"
            >
              关闭密码访问
            </button>
          </div>
        )}
      </div>
      {access.accessMode === "password" && access.passwordStatus === "available" ? (
        <div className="mt-4 rounded-lg bg-slate-50 p-4">
          <p className="text-xs font-medium text-slate-500">当前访问密码</p>
          <code className="mt-1 block select-all break-all text-lg font-semibold tracking-wider">
            {access.accessPassword}
          </code>
          <CopyCodeButton label="复制密码" value={access.accessPassword ?? ""} />
        </div>
      ) : null}
      {access.accessMode === "password" && access.passwordStatus === "unavailable" ? (
        <p
          className="mt-4 rounded-lg bg-amber-50 p-4 text-sm leading-6 text-amber-950"
          role="status"
        >
          历史密码不可显示。原密码仍可访问；如需在管理端查看，请明确选择“重新生成密码”。
        </p>
      ) : null}
      {error === null ? null : (
        <p className="mt-4 text-sm text-rose-700" role="alert">
          {error.message}
          {error.login ? (
            <Link className="ml-2 font-semibold underline" href="/login">
              前往登录
            </Link>
          ) : null}
        </p>
      )}
      <p aria-live="polite" className="mt-3 text-sm text-emerald-700">
        {notice}
      </p>
      {confirmation === null ? null : (
        <PasswordAccessConfirmDialog
          action={confirmation}
          onCancel={closeConfirmation}
          onConfirm={() => void submit(confirmation)}
          submitting={submitting}
        />
      )}
    </section>
  );
}

function successMessage(action: PasswordAccessAction) {
  if (action === "enable") return "已开启密码访问。";
  if (action === "regenerate") return "已重新生成密码，旧密码已失效。";
  return "已关闭密码访问。";
}

class ManagementRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(code ?? "password_management_failed");
  }
}

function errorMessage(error: unknown) {
  if (!(error instanceof ManagementRequestError)) {
    return { message: "网络连接失败，请检查网络后再次提交。" };
  }
  if (error.status === 401) return { login: true, message: "登录状态已过期。" };
  if (error.status === 403 || error.status === 404) {
    return { message: "项目不存在或你已无权管理，请返回 Demo 列表确认。" };
  }
  if (error.status === 409 && error.code === "project_upload_conflict") {
    return { message: "项目正在发布，请等待发布完成后重试。" };
  }
  if (error.status === 409) return { message: "访问方式已变化，请重新加载后再试。" };
  if (error.status === 429) return { message: "操作过于频繁，请稍后重试。" };
  return { message: "操作未完成，当前访问方式未改变，请再次提交。" };
}
