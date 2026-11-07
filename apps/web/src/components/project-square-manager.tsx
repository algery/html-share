"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  audienceSummary,
  SQUARE_SCOPE_NOTICE,
  squareDraft,
  type SquareDraft,
  type SquareSettingsResponse,
} from "../lib/square-types";
import { SquareAudiencePicker } from "./square-audience-picker";
import { ProjectSquareConfirmDialog } from "./project-square-confirm-dialog";

export function ProjectSquareManager({ apiUrl, projectId }: { apiUrl: string; projectId: string }) {
  const [data, setData] = useState<SquareSettingsResponse | null>(null);
  const [draft, setDraft] = useState<SquareDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [confirmation, setConfirmation] = useState(false);
  const [error, setError] = useState<{
    message: string;
    login?: boolean;
    conflict?: boolean;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const sectionRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const endpoint = `${apiUrl}/api/projects/${encodeURIComponent(projectId)}/square`;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void fetch(endpoint, { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new SquareRequestError(response.status);
        const next = (await response.json()) as SquareSettingsResponse;
        if (controller.signal.aborted) return;
        setData(next);
        setDraft((current) => current ?? squareDraft(next.settings));
        setError(null);
        if (attempt > 0) setNotice("已重新加载共享状态；当前范围草稿已保留，请核对后保存。");
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(squareError(caught, true));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [endpoint, attempt]);

  function closeConfirmation() {
    setConfirmation(false);
    requestAnimationFrame(() => {
      if (triggerRef.current?.isConnected) triggerRef.current.focus();
      else sectionRef.current?.focus();
    });
  }

  async function save(enabled: boolean) {
    if (submitting || data === null || draft === null) return;
    if (!data.csrfToken) {
      setError({ message: "安全校验已过期，请重新登录。", login: true });
      closeConfirmation();
      return;
    }
    setSubmitting(true);
    setError(null);
    setNotice("");
    const body = enabled
      ? {
          enabled,
          settingsVersion: data.settings.settingsVersion,
          audienceType: draft.audienceType,
          ...(draft.audienceType === "selected"
            ? {
                departmentIds: draft.departments.map((item) => item.id),
                userIds: draft.users.map((item) => item.id),
              }
            : {}),
        }
      : { enabled: false, settingsVersion: data.settings.settingsVersion };
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-html-share-csrf": data.csrfToken },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new SquareRequestError(response.status);
      const next = (await response.json()) as SquareSettingsResponse;
      setData(next);
      setDraft(squareDraft(next.settings));
      setNotice(
        enabled ? "广场共享已保存。" : "已关闭广场共享，上次范围已保留。原有内容链接仍可访问。",
      );
    } catch (caught) {
      setError(squareError(caught));
    } finally {
      setSubmitting(false);
      if (confirmation) closeConfirmation();
    }
  }

  const selectedCount = draft === null ? 0 : draft.departments.length + draft.users.length;
  const valid =
    draft?.audienceType === "organization" ||
    (draft?.audienceType === "selected" && selectedCount > 0 && selectedCount <= 100);
  return (
    <section
      aria-labelledby="project-square-title"
      className="project-setting-row scroll-mt-5"
      id="project-square"
      ref={sectionRef}
      tabIndex={-1}
    >
      <div className="min-w-0">
        <h2 className="section-title" id="project-square-title">
          广场共享
        </h2>
        {data !== null ? (
          <p className="mt-2 text-sm">
            <span
              className={`status-badge ${data.settings.enabled ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-600"}`}
            >
              {data.settings.enabled ? "已共享" : "未共享"}
            </span>
            <span className="mt-2 block text-xs leading-5 text-slate-500">
              已保存范围：{audienceSummary(squareDraft(data.settings))}
            </span>
          </p>
        ) : null}
      </div>
      <div className="min-w-0">
        <p className="text-xs leading-5 text-slate-500">{SQUARE_SCOPE_NOTICE}</p>
        {loading ? (
          <p className="mt-3 text-sm text-slate-500" role="status">
            正在加载共享设置…
          </p>
        ) : null}
        {draft !== null ? (
          <>
            <SquareAudiencePicker
              apiUrl={apiUrl}
              disabled={submitting || loading}
              draft={draft}
              onChange={(value) => {
                setDraft(value);
                setNotice("");
              }}
            />
            <p className="mt-3 text-xs leading-5 text-slate-500">
              当前草稿：{audienceSummary(draft)}。选择只在确认发布或保存范围后生效。
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {data?.settings.enabled ? (
                <button
                  className="button-secondary"
                  disabled={!valid || submitting || loading}
                  onClick={() => void save(true)}
                  type="button"
                >
                  {submitting ? "正在保存…" : "保存范围"}
                </button>
              ) : (
                <button
                  className="button-secondary"
                  disabled={!valid || submitting || loading}
                  onClick={(event) => {
                    triggerRef.current = event.currentTarget;
                    setConfirmation(true);
                  }}
                  type="button"
                >
                  发布到广场
                </button>
              )}
            </div>
            {data?.settings.enabled ? (
              <div className="mt-4 border-t border-slate-200 pt-3">
                <button
                  className="min-h-10 text-sm font-medium text-rose-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
                  disabled={submitting || loading}
                  onClick={() => void save(false)}
                  type="button"
                >
                  关闭共享
                </button>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  仅从广场撤下，保留上次范围。
                </p>
              </div>
            ) : null}
          </>
        ) : null}
        {error !== null ? (
          <div className="mt-3 text-sm leading-6 text-rose-700" role="alert">
            <p>{error.message}</p>
            {error.login ? (
              <Link className="inline-flex min-h-10 items-center underline" href="/login">
                前往登录
              </Link>
            ) : null}
            {error.conflict || data === null ? (
              <button
                className="button-secondary mt-2"
                disabled={loading || submitting}
                onClick={() => setAttempt((value) => value + 1)}
                type="button"
              >
                重新加载共享设置
              </button>
            ) : null}
          </div>
        ) : null}
        <p aria-live="polite" className="mt-3 text-sm leading-6 text-emerald-700 empty:mt-0">
          {notice}
        </p>
        {confirmation && draft !== null ? (
          <ProjectSquareConfirmDialog
            summary={audienceSummary(draft)}
            submitting={submitting}
            onCancel={closeConfirmation}
            onConfirm={() => void save(true)}
          />
        ) : null}
      </div>
    </section>
  );
}

class SquareRequestError extends Error {
  constructor(readonly status: number) {
    super("square_request_failed");
  }
}

function squareError(error: unknown, loading = false) {
  if (!(error instanceof SquareRequestError))
    return { message: "网络连接失败，当前设置和草稿已保留，请重试。" };
  if (error.status === 401) return { message: "登录状态已过期，请重新登录。", login: true };
  if (error.status === 404 || error.status === 403)
    return { message: "项目不存在或你已无权管理，请返回我的 Demo 确认。" };
  if (error.status === 409)
    return {
      message: "共享设置已变化或项目正在发布。草稿已保留，请重新加载共享设置后核对并重试。",
      conflict: true,
    };
  if (error.status === 503)
    return {
      message: "组织目录暂不可用或权限不足，当前设置和草稿已保留。请重试；已共享项目仍可关闭共享。",
    };
  if (error.status === 400)
    return { message: "范围中存在无效或不可选择的对象，请检查已选范围后重试。当前设置未改变。" };
  if (error.status === 429) return { message: "操作过于频繁，请稍后重试。当前设置和草稿已保留。" };
  return {
    message: loading
      ? "共享设置暂时无法加载，请重试。"
      : "保存失败，当前设置和草稿已保留，请重试。",
  };
}
