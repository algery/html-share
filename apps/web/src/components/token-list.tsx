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
    <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
      <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="px-4 py-3 font-medium">名称</th>
            <th className="px-4 py-3 font-medium">末尾字符</th>
            <th className="px-4 py-3 font-medium">状态</th>
            <th className="px-4 py-3 font-medium">创建时间</th>
            <th className="px-4 py-3 font-medium">到期</th>
            <th className="px-4 py-3 font-medium">最近使用</th>
            <th className="px-4 py-3">
              <span className="sr-only">操作</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 bg-white">
          {tokens.map((token) => (
            <tr key={token.id}>
              <td className="px-4 py-3 font-medium">{token.name}</td>
              <td className="px-4 py-3 font-mono">••••{token.tokenSuffix}</td>
              <td className="px-4 py-3">{token.status === "active" ? "可用" : "已吊销"}</td>
              <td className="px-4 py-3">{formatDate(token.createdAt)}</td>
              <td className="px-4 py-3">{formatDate(token.expiresAt)}</td>
              <td className="px-4 py-3">
                {token.lastUsedAt === null ? "尚未使用" : formatDate(token.lastUsedAt)}
              </td>
              <td className="px-4 py-3">
                {token.status === "active" ? (
                  <button
                    className="font-semibold text-rose-700 hover:text-rose-800"
                    onClick={() => onRevoke(token)}
                    type="button"
                  >
                    吊销
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
