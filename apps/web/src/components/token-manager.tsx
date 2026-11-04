"use client";

import { useEffect, useId, useMemo, useState } from "react";

import { McpConnectionGuide } from "./mcp-connection-guide";
import { TokenCreatedPanel } from "./token-created-panel";
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
      const csrfToken = await requestCsrfToken(apiUrl);
      const response = await fetch(endpoint, {
        body: JSON.stringify({ name }),
        credentials: "include",
        headers: { "content-type": "application/json", "x-html-share-csrf": csrfToken },
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
      const csrfToken = await requestCsrfToken(apiUrl);
      const response = await fetch(`${endpoint}/${encodeURIComponent(token.id)}/revoke`, {
        credentials: "include",
        headers: { "x-html-share-csrf": csrfToken },
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
    <main className="workspace">
      <header className="workspace-header">
        <div className="min-w-0">
          <h1 className="page-title">我的 Token</h1>
          <p className="page-description mt-2">
            用于连接 Codex / Claude Code，有效期 30 天，完整值仅创建时展示一次。
          </p>
        </div>
      </header>

      {createdValue !== null ? (
        <TokenCreatedPanel
          expiresAt={createdExpiresAt}
          value={createdValue}
          onDismiss={() => {
            setCreatedValue(null);
            setCreatedExpiresAt(null);
          }}
        />
      ) : null}

      <section className="surface mt-6" aria-labelledby="create-token-title">
        <h2 className="section-title" id="create-token-title">
          创建 Token
        </h2>
        <form
          className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void createToken();
          }}
        >
          <label className="min-w-0 flex-1 text-sm font-medium text-slate-800">
            Token 名称
            <input
              className="field mt-2 w-full"
              disabled={isSubmitting}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：我的 Codex"
              required
              value={name}
            />
          </label>
          <button
            className="button-primary shrink-0"
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
      </section>

      {error !== null ? <TokenError message={error} onRetry={retry} /> : null}

      <section className="mt-6" aria-labelledby="token-list-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="token-list-title" className="section-title">
            已创建的 Token
          </h2>
          <button
            aria-controls={guideId}
            aria-expanded={isGuideOpen}
            className="button-secondary"
            onClick={() => setIsGuideOpen((current) => !current)}
            type="button"
          >
            {isGuideOpen ? "收起连接配置" : "查看 Codex / Claude Code 配置"}
          </button>
        </div>
        {isGuideOpen ? (
          <div className="config-panel" id={guideId}>
            <McpConnectionGuide apiUrl={apiUrl} mcpUrl={`${apiUrl}/mcp`} />
          </div>
        ) : null}
        {isLoading ? <TokenSkeleton /> : null}
        {!isLoading && tokens.length === 0 ? <EmptyTokenState /> : null}
        {!isLoading && tokens.length > 0 ? (
          <TokenList tokens={tokens} onRevoke={revokeToken} />
        ) : null}
      </section>
    </main>
  );
}

async function requestCsrfToken(apiUrl: string) {
  const response = await fetch(`${apiUrl}/api/csrf`, { credentials: "include" });
  if (!response.ok) throw new Error(await readError(response));
  const body = (await response.json()) as { csrfToken: string | null };
  if (body.csrfToken === null) throw new Error("csrf_missing");
  return body.csrfToken;
}

function TokenSkeleton() {
  return (
    <div aria-label="正在加载 Token" aria-busy="true" className="table-shell mt-4">
      <div
        aria-hidden="true"
        className="hidden justify-between bg-slate-50 px-4 py-3 text-xs text-slate-500 md:flex"
      >
        <span>名称</span>
        <span>末尾字符</span>
        <span>状态</span>
        <span>创建时间</span>
        <span>到期</span>
        <span>最近使用</span>
      </div>
      {[0, 1, 2].map((row) => (
        <div
          aria-hidden="true"
          className="flex h-16 items-center gap-8 border-t border-slate-200 px-4"
          key={row}
        >
          <span className="h-3 w-44 animate-pulse rounded bg-slate-100" />
          <span className="h-3 w-24 animate-pulse rounded bg-slate-100" />
          <span className="h-3 w-20 animate-pulse rounded bg-slate-100" />
        </div>
      ))}
    </div>
  );
}
function EmptyTokenState() {
  return (
    <p className="surface mt-4 text-sm leading-6 text-slate-600">
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
