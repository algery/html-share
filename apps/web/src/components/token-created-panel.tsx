import { CopyCodeButton } from "./copy-code-button";

export function TokenCreatedPanel({
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
      className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 sm:p-6"
      aria-labelledby="created-token-title"
    >
      <h2 id="created-token-title" className="section-title text-amber-950">
        请立即复制 Token
      </h2>
      <p className="mt-2 text-sm leading-6 text-amber-900">
        完整值仅展示一次，关闭或刷新页面后无法再次查看。
      </p>
      <p className="mt-1 text-xs leading-5 text-amber-900">
        {expiresAt === null
          ? "永久有效"
          : `到期时间：${new Intl.DateTimeFormat("zh-CN", {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(expiresAt))}`}
      </p>
      <code className="mt-4 block min-w-0 break-all rounded-md border border-amber-200 bg-white p-3 font-mono text-sm leading-6 text-slate-900">
        {value}
      </code>
      <div className="mt-3 flex flex-wrap items-start gap-3">
        <CopyCodeButton compact label="复制" value={value} />
        <button className="button-primary" onClick={onDismiss} type="button">
          我已保存
        </button>
      </div>
    </section>
  );
}
