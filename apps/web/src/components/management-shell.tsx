"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";

interface ManagementShellProps {
  apiUrl: string;
  children: ReactNode;
}

interface CurrentUser {
  displayName: string;
}

export function ManagementShell({ apiUrl, children }: ManagementShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === "/login";
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [status, setStatus] = useState<"checking" | "ready" | "error">("checking");
  const endpoint = useMemo(() => `${apiUrl}/auth/current`, [apiUrl]);

  useEffect(() => {
    if (isLogin) return;
    let active = true;
    void fetch(endpoint, { credentials: "include" }).then(
      async (response) => {
        if (!active) return;
        if (response.status === 401) {
          router.replace("/login");
          return;
        }
        if (!response.ok) {
          setStatus("error");
          return;
        }
        const body = (await response.json()) as { user: CurrentUser };
        setUser(body.user);
        setStatus("ready");
      },
      () => {
        if (active) setStatus("error");
      },
    );
    return () => {
      active = false;
    };
  }, [endpoint, isLogin, router]);

  async function logout() {
    await fetch(`${apiUrl}/auth/logout`, { credentials: "include", method: "POST" });
    router.replace("/login");
  }

  if (isLogin) return <>{children}</>;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex min-h-16 w-full max-w-5xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 sm:px-6">
          <Link className="text-base font-semibold tracking-tight" href="/demos">
            HTML Share
          </Link>
          <nav aria-label="管理导航" className="flex min-h-11 items-center gap-1">
            <NavigationLink active={pathname === "/demos"} href="/demos">
              我的 Demo
            </NavigationLink>
            <NavigationLink active={pathname === "/tokens"} href="/tokens">
              我的 Token
            </NavigationLink>
          </nav>
          <div className="ml-auto flex min-h-11 items-center gap-3 text-sm">
            <span aria-live="polite" className="max-w-32 truncate text-slate-600 sm:max-w-48">
              {status === "ready" ? user?.displayName : "正在验证身份…"}
            </span>
            <button
              className="font-semibold text-slate-700 hover:text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700"
              onClick={() => void logout()}
              type="button"
            >
              退出
            </button>
          </div>
        </div>
      </header>
      {status === "error" ? <ManagementUnavailable /> : children}
    </div>
  );
}

function NavigationLink({
  active,
  children,
  href,
}: {
  active: boolean;
  children: ReactNode;
  href: string;
}) {
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={`inline-flex min-h-10 items-center rounded-md px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 ${
        active
          ? "bg-blue-50 text-blue-800"
          : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
      }`}
      href={href}
    >
      {children}
    </Link>
  );
}

function ManagementUnavailable() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
      <section className="rounded-2xl border border-rose-200 bg-white p-6 shadow-sm sm:p-10">
        <h1 className="text-xl font-semibold">管理端暂时不可用</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          无法验证当前登录态。请刷新页面；若问题持续，请携带诊断编号 MANAGEMENT_AUTH_UNAVAILABLE
          联系管理员。
        </p>
      </section>
    </main>
  );
}
