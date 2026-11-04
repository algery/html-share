export interface TokenSummary {
  id: string;
  name: string;
  status: "active" | "revoked";
  tokenSuffix: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface TokenListProps {
  tokens: TokenSummary[];
  onRevoke: (token: TokenSummary) => void;
}

export function TokenList({ tokens, onRevoke }: TokenListProps) {
  return (
    <>
      <div className="table-shell mt-4 hidden md:block">
        <table className="w-full min-w-[1080px] table-fixed divide-y divide-slate-200 text-left text-sm">
          <thead className="bg-slate-50 text-xs text-slate-600">
            <tr>
              <th className="w-[25%] min-w-60 px-4 py-3 font-medium">名称</th>
              <th className="w-[11%] px-4 py-3 font-medium">末尾字符</th>
              <th className="w-[9%] px-4 py-3 font-medium">状态</th>
              <th className="w-[16%] px-4 py-3 font-medium">创建时间</th>
              <th className="w-[16%] px-4 py-3 font-medium">到期</th>
              <th className="w-[16%] px-4 py-3 font-medium">最近使用</th>
              <th className="w-[7%] px-3 py-3">
                <span className="sr-only">操作</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 bg-white">
            {tokens.map((token) => (
              <tr key={token.id} className="transition-colors duration-150 hover:bg-slate-50">
                <td className="px-4 py-3 font-semibold">
                  <span className="block truncate" title={token.name}>
                    {token.name}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-600">
                  ••••{token.tokenSuffix}
                </td>
                <td className="px-4 py-3">
                  <TokenStatus status={token.status} />
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums text-slate-600">
                  <TokenDate value={token.createdAt} />
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums text-slate-600">
                  <TokenDate value={token.expiresAt} />
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums text-slate-600">
                  {token.lastUsedAt === null ? "尚未使用" : <TokenDate value={token.lastUsedAt} />}
                </td>
                <td className="px-2 py-2">
                  <RevokeButton token={token} onRevoke={onRevoke} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 grid gap-3 md:hidden">
        {tokens.map((token) => (
          <article className="surface min-w-0" key={token.id}>
            <div className="flex items-start justify-between gap-3">
              <h3 className="min-w-0 break-all text-sm font-semibold leading-6">{token.name}</h3>
              <TokenStatus status={token.status} />
            </div>
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs leading-5">
              <dt className="text-slate-500">末尾字符</dt>
              <dd className="break-all font-mono">••••{token.tokenSuffix}</dd>
              <dt className="text-slate-500">创建时间</dt>
              <dd className="tabular-nums">
                <TokenDate value={token.createdAt} />
              </dd>
              <dt className="text-slate-500">到期</dt>
              <dd className="tabular-nums">
                <TokenDate value={token.expiresAt} />
              </dd>
              <dt className="text-slate-500">最近使用</dt>
              <dd className="tabular-nums">
                {token.lastUsedAt === null ? "尚未使用" : <TokenDate value={token.lastUsedAt} />}
              </dd>
            </dl>
            {token.status === "active" ? (
              <div className="mt-3 border-t border-slate-200 pt-2 text-right">
                <RevokeButton token={token} onRevoke={onRevoke} />
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </>
  );
}

function TokenStatus({ status }: { status: TokenSummary["status"] }) {
  return (
    <span
      className={`status-badge shrink-0 ${status === "active" ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-600"}`}
    >
      {status === "active" ? "可用" : "已吊销"}
    </span>
  );
}

function RevokeButton({
  token,
  onRevoke,
}: {
  token: TokenSummary;
  onRevoke: TokenListProps["onRevoke"];
}) {
  if (token.status !== "active") return null;
  return (
    <button
      className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-md px-2 text-sm font-semibold text-rose-700 hover:bg-rose-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700"
      onClick={() => onRevoke(token)}
      type="button"
    >
      吊销
    </button>
  );
}

function TokenDate({ value }: { value: string }) {
  return (
    <time dateTime={value} title={new Date(value).toLocaleString("zh-CN")}>
      {new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(value))}
    </time>
  );
}
