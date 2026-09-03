"use client";

import { useEffect, useId, useMemo, useState } from "react";

import { McpConnectionGuide } from "./mcp-connection-guide";
import { TokenList, type TokenSummary } from "./token-list";

interface TokenManagerProps {
  apiUrl: string;
}

export function TokenManager({ apiUrl }: TokenManagerProps) {
  const [tokens, setTokens] = useState<TokenSummary[]>([]);
  const [name, setName] = useState("");
  const [createdValue, setCreatedValue] = useState<string | null>(null);
  const [createdExpiresAt, setCreatedExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGuideOpen, setIsGuideOpen] = useState(false);
  const guideId = useId();

  const endpoint = useMemo(() => `${apiUrl}/api/tokens`, [apiUrl]);

  useEffect(() => {
    void refreshTokens(endpoint, setTokens, setError, setIsLoading);
  }, [endpoint]);

  async function retry() {
    setIsLoading(true);
    setError(null);
    await refreshTokens(endpoint, setTokens, setError, setIsLoading);
  }

  async function createToken() {
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch(endpoint, {
        body: JSON.stringify({ name }),
        credentials: "include",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error(await readError(response));
      const body = (await response.json()) as { token: TokenSummary; value: string };
      setCreatedValue(body.value);
      setCreatedExpiresAt(body.token.expiresAt);
      setName("");
      setTokens((current) => [body.token, ...current]);
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function revokeToken(token: TokenSummary) {
    if (!window.confirm(`确定吊销「${token.name}」吗？吊销后连接会立即失效。`)) return;
    setError(null);
    try {
      const response = await fetch(`${endpoint}/${encodeURIComponent(token.id)}/revoke`, {
        credentials: "include",
        method: "POST",
      });
      if (!response.ok) throw new Error(await readError(response));
      setTokens((current) =>
        current.map((entry) =>
          entry.id === token.id
            ? { ...entry, revokedAt: new Date().toISOString(), status: "revoked" }
            : entry,
        ),
      );
    } catch (reason) {
      setError(toMessage(reason));
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-10">
        <p className="text-sm font-semibold text-blue-700">我的 Token</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance">连接你的 Agent</h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600">
          Token 只会在创建成功时完整展示一次。它只用于 MCP 连接，30 天后自动过期。
        </p>

        {createdValue !== null ? (
          <CreatedToken
            expiresAt={createdExpiresAt}
            value={createdValue}
            onDismiss={() => {
              setCreatedValue(null);
              setCreatedExpiresAt(null);
            }}
          />
        ) : null}

        <form
          className="mt-8 flex flex-col gap-3 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            void createToken();
          }}
        >
          <label className="min-w-0 flex-1 text-sm font-medium text-slate-800">
            Token 名称
            <input
              className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base outline-none ring-blue-700 transition focus:border-blue-700 focus:ring-2"
              disabled={isSubmitting}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：我的 Codex"
              required
              value={name}
            />
          </label>
          <button
            className="mt-6 inline-flex min-h-11 items-center justify-center rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-400 sm:mt-auto"
            disabled={isSubmitting || name.trim().length === 0}
            type="submit"
          >
            {isSubmitting ? "正在创建…" : "创建 Token"}
          </button>
        </form>

        {tokens.some((token) => token.name.trim() === name.trim()) && name.trim().length > 0 ? (
          <p className="mt-2 text-sm text-amber-800">
            已有同名 Token；仍可创建，但建议用不同名称便于识别。
          </p>
        ) : null}

        {error !== null ? <TokenError message={error} onRetry={retry} /> : null}

        <section className="mt-10" aria-labelledby="token-list-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="token-list-title" className="text-lg font-semibold tracking-tight">
              已创建的 Token
            </h2>
            <button
              aria-controls={guideId}
              aria-expanded={isGuideOpen}
              className="text-sm font-semibold text-blue-700 hover:text-blue-800"
              onClick={() => setIsGuideOpen((current) => !current)}
              type="button"
            >
              {isGuideOpen ? "收起连接配置" : "查看 Codex / Claude Code 配置"}
            </button>
          </div>
          {isGuideOpen ? (
            <div id={guideId}>
              <McpConnectionGuide apiUrl={apiUrl} mcpUrl={`${apiUrl}/mcp`} />
            </div>
          ) : null}
          {isLoading ? <TokenSkeleton /> : null}
          {!isLoading && tokens.length === 0 ? <EmptyTokenState /> : null}
          {!isLoading && tokens.length > 0 ? (
            <TokenList tokens={tokens} onRevoke={revokeToken} />
          ) : null}
        </section>
      </section>
    </main>
  );
}

function CreatedToken({
  expiresAt,
  value,
  onDismiss,
}: {
  expiresAt: string | null;
  value: string;
  onDismiss: () => void;
}) {
  return (
    <section
      className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-4"
      aria-labelledby="created-token-title"
    >
      <h2 id="created-token-title" className="font-semibold text-amber-950">
        请立即复制 Token
      </h2>
      <p className="mt-1 text-sm leading-6 text-amber-900">
        关闭或刷新页面后，平台无法再次显示完整值。
      </p>
      {expiresAt === null ? null : (
        <p className="mt-1 text-sm leading-6 text-amber-900">到期时间：{formatDate(expiresAt)}</p>
      )}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-white px-3 py-2 text-sm text-slate-900">
          {value}
        </code>
        <button
          className="min-h-10 rounded-md bg-amber-700 px-4 text-sm font-semibold text-white hover:bg-amber-800"
          onClick={() => void navigator.clipboard.writeText(value)}
          type="button"
        >
          复制
        </button>
        <button
          className="min-h-10 rounded-md border border-amber-300 px-4 text-sm font-semibold text-amber-950"
          onClick={onDismiss}
          type="button"
        >
          我已保存
        </button>
      </div>
    </section>
  );
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function TokenSkeleton() {
  return (
    <div className="mt-4 h-32 animate-pulse rounded-xl bg-slate-100" aria-label="正在加载 Token" />
  );
}
function EmptyTokenState() {
  return (
    <p className="mt-4 rounded-xl bg-slate-50 p-5 text-sm leading-6 text-slate-600">
      还没有 Token。创建一个 Token 后，将它放入 Codex 或 Claude Code 的 Authorization Header。
    </p>
  );
}
function TokenError({ message, onRetry }: { message: string; onRetry: () => Promise<void> }) {
  const expired = message.includes("登录状态已过期");
  return (
    <section
      className="mt-4 rounded-lg bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-800"
      role="alert"
    >
      <p>{message}</p>
      <p className="mt-1">诊断编号：{expired ? "TOKEN_SESSION_EXPIRED" : "TOKEN_REQUEST_FAILED"}</p>
      {expired ? (
        <a
          className="mt-3 inline-flex min-h-10 items-center rounded-md bg-rose-800 px-3 font-semibold text-white hover:bg-rose-900"
          href="/login"
        >
          前往登录
        </a>
      ) : (
        <button
          className="mt-3 min-h-10 rounded-md border border-rose-300 bg-white px-3 font-semibold hover:bg-rose-100"
          onClick={() => void onRetry()}
          type="button"
        >
          重试
        </button>
      )}
    </section>
  );
}
async function refreshTokens(
  endpoint: string,
  setTokens: (tokens: TokenSummary[]) => void,
  setError: (error: string | null) => void,
  setIsLoading: (isLoading: boolean) => void,
) {
  try {
    const response = await fetch(endpoint, { credentials: "include" });
    if (!response.ok) throw new Error(await readError(response));
    const body = (await response.json()) as { tokens: TokenSummary[] };
    setTokens(body.tokens);
  } catch (reason) {
    setError(toMessage(reason));
  } finally {
    setIsLoading(false);
  }
}
async function readError(response: Response) {
  if (response.status === 401) return "登录状态已过期，请先完成钉钉登录。";
  if (response.status === 403) return "当前页面来源不被允许，请从管理端重新打开。";
  return "操作未完成，请重试。";
}
function toMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : "操作未完成，请重试。";
}
