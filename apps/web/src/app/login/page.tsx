import Link from "next/link";

import { DingTalkInAppLogin } from "../../components/dingtalk-in-app-login";
import { resolveLoginState } from "../../lib/login-state";

interface LoginPageProps {
  searchParams: Promise<{ status?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { status } = await searchParams;
  const state = resolveLoginState(status);
  const authorizationUrl = `${process.env["NEXT_PUBLIC_API_URL"] ?? ""}/auth/login`;
  const apiUrl = process.env["NEXT_PUBLIC_API_URL"] ?? "";
  const isError = state.tone === "error";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg items-center px-4 py-12 sm:px-6">
      <section className="w-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-10">
        <p className="text-sm font-semibold text-blue-700">HTML Share</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance">{state.title}</h1>
        <p className="mt-4 text-base leading-7 text-slate-600">{state.description}</p>

        <div
          aria-live="polite"
          className={`mt-8 rounded-xl p-4 text-sm leading-6 ${
            isError ? "bg-rose-50 text-rose-800" : "bg-slate-50 text-slate-700"
          }`}
        >
          登录态按管理端与 Demo 内容端分别保存，退出或过期后需要重新授权。
        </div>

        <div className="mt-4 text-sm leading-6 text-slate-600">
          <DingTalkInAppLogin
            apiUrl={apiUrl}
            clientId={process.env["NEXT_PUBLIC_DINGTALK_CLIENT_ID"]}
            corpId={process.env["NEXT_PUBLIC_DINGTALK_CORP_ID"]}
            returnPath="/"
          />
        </div>

        <a
          className="mt-8 inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700"
          href={authorizationUrl}
        >
          前往钉钉授权
        </a>
        <Link
          className="mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-semibold text-slate-800 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700"
          href="/"
        >
          返回管理端
        </Link>
      </section>
    </main>
  );
}
