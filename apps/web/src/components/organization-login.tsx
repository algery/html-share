"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Brand } from "./brand";
import { DingTalkInAppLogin } from "./dingtalk-in-app-login";
import { resolveLoginState } from "../lib/login-state";

export function OrganizationLogin({
  apiUrl,
  status,
  clientId,
  corpId,
}: {
  apiUrl: string;
  status?: string | undefined;
  clientId?: string | undefined;
  corpId?: string | undefined;
}) {
  const [feishu, setFeishu] = useState(false);
  const [configuration, setConfiguration] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${apiUrl}/auth/config`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("configuration unavailable");
        const value: unknown = await response.json();
        if (
          typeof value !== "object" ||
          value === null ||
          !("feishu" in value) ||
          typeof value.feishu !== "boolean"
        )
          throw new Error("invalid configuration");
        setFeishu(value.feishu);
        setConfiguration("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setConfiguration("error");
      });
    return () => controller.abort();
  }, [apiUrl, attempt]);
  const state = resolveLoginState(status);
  const isDefault = state.tone === "default" && status !== "verifying";
  return (
    <section className="surface w-full">
      <Brand />
      <h1 className="page-title mt-4">{feishu && isDefault ? "登录 Demo Share" : state.title}</h1>
      <p className="page-description mt-3">
        {feishu && isDefault ? "使用组织的钉钉或飞书账户继续。" : state.description}
      </p>
      <div
        aria-live="polite"
        className={`mt-6 rounded-lg p-3 text-sm leading-6 ${state.tone === "error" ? "bg-rose-50 text-rose-800" : "bg-slate-50 text-slate-700"}`}
      >
        管理端与 Demo 的登录状态分别保存，退出或过期后需重新授权。
      </div>
      <div className="mt-4 text-sm leading-6 text-slate-600">
        <DingTalkInAppLogin apiUrl={apiUrl} clientId={clientId} corpId={corpId} returnPath="/" />
      </div>
      <a className="button-primary mt-6 flex w-full" href={`${apiUrl}/auth/login`}>
        前往钉钉授权
      </a>
      {feishu && (
        <>
          <a className="button-secondary mt-3 flex w-full" href={`${apiUrl}/auth/feishu/login`}>
            前往飞书授权
          </a>
          <p className="mt-4 text-sm leading-6 text-slate-600">
            已有钉钉账户？请先用钉钉登录一次，补齐手机号或邮箱后再用飞书登录。相同联系方式可自动关联账户。
          </p>
        </>
      )}
      {configuration === "loading" && (
        <p className="mt-3 text-sm text-slate-600" role="status">
          正在读取登录方式…
        </p>
      )}
      {configuration === "error" && (
        <p className="mt-3 text-sm text-rose-800" role="status">
          暂时无法读取其他登录方式。
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => {
              setConfiguration("loading");
              setAttempt(attempt + 1);
            }}
          >
            重试
          </button>
        </p>
      )}
      <Link className="button-secondary mt-3 flex w-full" href="/">
        返回管理端
      </Link>
    </section>
  );
}
