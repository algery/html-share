import Link from "next/link";

export function SquareLoadState({
  status,
  onRetry,
  list = false,
}: {
  status: "loading" | "error" | "expired" | "missing";
  onRetry: () => void;
  list?: boolean;
}) {
  if (status === "loading")
    return (
      <div aria-label="正在加载广场内容" className="space-y-3" role="status">
        {list ? (
          <div className="table-shell hidden md:block">
            <table className="data-table">
              <thead>
                <tr>
                  {["名称", "创建者", "内容更新时间", "查看"].map((label) => (
                    <th className="px-4 py-3" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
            </table>
          </div>
        ) : null}
        {Array.from({ length: list ? 8 : 4 }, (_, row) => row).map((row) => (
          <div
            aria-hidden="true"
            className="h-16 animate-pulse rounded-lg border border-slate-200 bg-white"
            key={row}
          />
        ))}
      </div>
    );
  const title =
    status === "expired"
      ? "登录状态已过期"
      : status === "missing"
        ? "项目不存在或无法访问"
        : "无法加载广场内容";
  return (
    <section className="rounded-lg bg-slate-100 p-5 text-sm leading-6" role="alert">
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-1 text-slate-600">
        {status === "missing"
          ? "该项目可能已撤回，或你不在当前可见范围内。请返回项目广场查看。"
          : status === "expired"
            ? "请重新完成钉钉登录后查看项目广场。"
            : "未能确认当前可见内容，已清除旧展示。请重试。"}
      </p>
      {status === "expired" ? (
        <Link className="button-secondary mt-3" href="/login">
          前往登录
        </Link>
      ) : status !== "missing" ? (
        <button className="button-secondary mt-3" onClick={onRetry} type="button">
          重试
        </button>
      ) : null}
    </section>
  );
}
