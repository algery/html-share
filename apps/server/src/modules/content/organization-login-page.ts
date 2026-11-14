import type { FastifyReply } from "fastify";

export function sendOrganizationLoginPage(
  reply: FastifyReply,
  input: {
    dingtalkUrl: string;
    feishuUrl: string;
    status?: string;
  },
) {
  const message =
    input.status === "account-conflict"
      ? "账户联系方式存在冲突，无法自动关联。请使用原登录方式，或联系管理员核实。"
      : input.status === "denied"
        ? "当前身份无法访问此组织，请使用组织账户重新授权。"
        : input.status === "error"
          ? "授权未完成，请重新登录。"
          : "选择组织账号登录后，继续打开原链接。";
  return reply
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .header("x-robots-tag", "noindex")
    .header(
      "content-security-policy",
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'",
    )
    .type("text/html; charset=utf-8")
    .send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>组织登录 · Demo Share</title><style>
*{box-sizing:border-box}body{margin:0;padding:24px 16px;min-height:100svh;display:grid;place-items:center;background:#F6F7F9;color:#172033;font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:100%;max-width:400px;background:#fff;border:1px solid #E3E7EE;border-radius:8px;padding:24px}h1{font-size:24px;margin:0 0 12px}p{color:#647084}a{min-height:40px;display:flex;align-items:center;justify-content:center;padding:8px 16px;margin-top:12px;border:1px solid #E3E7EE;border-radius:8px;color:#263F72;text-decoration:none;font-weight:600}a:first-of-type{background:#263F72;color:white}a:focus-visible{outline:3px solid #315EC9;outline-offset:3px}.hint{font-size:13px;margin:20px 0 0}
</style></head><body><main><h1>登录 Demo Share</h1><p role="status">${message}</p><a href="${escapeHtml(input.dingtalkUrl)}">钉钉登录打开</a><a href="${escapeHtml(input.feishuUrl)}">飞书登录打开</a><p class="hint">已有钉钉账户？请先用钉钉登录一次，补齐手机号或邮箱后再用飞书登录。</p></main></body></html>`);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
