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
    <main className="mx-auto flex min-h-screen w-full max-w-md items-center px-4 py-8 sm:px-6">
      <section className="surface w-full">
        <p className="text-sm font-semibold text-blue-700">HTML Share</p>
        <h1 className="page-title mt-4">{state.title}</h1>
        <p className="page-description mt-3">{state.description}</p>

        <div
          aria-live="polite"
          className={`mt-6 rounded-lg p-3 text-sm leading-6 ${
            isError ? "bg-rose-50 text-rose-800" : "bg-slate-50 text-slate-700"
          }`}
        >
          管理端与 Demo 的登录状态分别保存，退出或过期后需重新授权。
        </div>

        <div className="mt-4 text-sm leading-6 text-slate-600">
          <DingTalkInAppLogin
            apiUrl={apiUrl}
            clientId={process.env["NEXT_PUBLIC_DINGTALK_CLIENT_ID"]}
            corpId={process.env["NEXT_PUBLIC_DINGTALK_CORP_ID"]}
            returnPath="/"
          />
        </div>

        <a className="button-primary mt-6 flex w-full" href={authorizationUrl}>
          前往钉钉授权
        </a>
        <Link className="button-secondary mt-3 flex w-full" href="/">
          返回管理端
        </Link>
      </section>
    </main>
  );
}
