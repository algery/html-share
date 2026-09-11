import { randomBytes } from "node:crypto";

import type { FastifyReply } from "fastify";

export function applyPasswordResponseHeaders(reply: FastifyReply) {
  return reply
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("x-robots-tag", "noindex")
    .header(
      "content-security-policy",
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
}

export function sendPasswordPage(
  reply: FastifyReply,
  input: {
    state: string;
    returnPath: string;
    loginFailed?: boolean;
  },
) {
  const nonce = randomBytes(18).toString("base64url");
  const loginParams = new URLSearchParams({
    return_path: input.returnPath,
    password_return: input.state,
  });
  const loginUrl = `/auth/content-login?${loginParams}`;
  const values = JSON.stringify({ state: input.state, returnPath: input.returnPath }).replaceAll(
    "<",
    "\\u003c",
  );
  return applyPasswordResponseHeaders(reply)
    .header(
      "content-security-policy",
      `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'`,
    )
    .type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>密码访问</title>
<style nonce="${nonce}">
*{box-sizing:border-box}
:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#101828;background:#f3f5f8;font-synthesis:none}
body{margin:0;min-height:100svh;display:grid;place-items:center;padding:32px 20px;line-height:1.5;background:radial-gradient(circle at 50% 0,#fff 0,#f7f8fa 34%,#f1f3f6 100%)}
.password-card{width:min(100%,420px);padding:40px;background:rgba(255,255,255,.96);border:1px solid #e4e7ec;border-radius:20px;box-shadow:0 20px 48px rgba(16,24,40,.08),0 4px 12px rgba(16,24,40,.04)}
.mark{display:grid;place-items:center;width:48px;height:48px;margin:0 auto 22px;border-radius:14px;background:#101828;color:#fff;box-shadow:0 8px 18px rgba(16,24,40,.16)}
.mark svg{width:24px;height:24px}h1{margin:0;text-align:center;font-size:24px;line-height:1.3;letter-spacing:-.02em;font-weight:650}
.intro{margin:10px 0 30px;text-align:center;color:#667085;font-size:14px}label{display:block;margin:0 0 8px;color:#344054;font-size:14px;font-weight:600}
input,button,.secondary{font:inherit;width:100%;min-height:48px;border-radius:10px}input{display:block;padding:12px 14px;color:#101828;background:#fff;border:1px solid #d0d5dd;box-shadow:0 1px 2px rgba(16,24,40,.04);outline:none;transition:border-color .16s,box-shadow .16s}
input::placeholder{color:#98a2b3}input:hover{border-color:#98a2b3}input:focus{border-color:#667085;box-shadow:0 0 0 4px rgba(102,112,133,.14)}input[aria-invalid="true"]{border-color:#d92d20;box-shadow:0 0 0 4px rgba(217,45,32,.1)}
button{margin-top:16px;padding:11px 16px;border:1px solid #101828;background:#101828;color:#fff;font-weight:600;cursor:pointer;box-shadow:0 1px 2px rgba(16,24,40,.12);transition:background .16s,transform .16s,box-shadow .16s}
button:hover{background:#1d2939;box-shadow:0 4px 10px rgba(16,24,40,.14)}button:active{transform:translateY(1px)}button:disabled{opacity:.58;cursor:wait;transform:none;box-shadow:none}
#status{min-height:21px;margin:10px 0 0;color:#b42318;font-size:13px}.divider{display:flex;align-items:center;gap:12px;margin:24px 0;color:#98a2b3;font-size:12px}
.divider::before,.divider::after{content:"";height:1px;flex:1;background:#eaecf0}.secondary{display:flex;align-items:center;justify-content:center;padding:11px 16px;color:#344054;background:#fff;border:1px solid #d0d5dd;font-weight:600;text-decoration:none;overflow-wrap:anywhere;box-shadow:0 1px 2px rgba(16,24,40,.04);transition:border-color .16s,background .16s,box-shadow .16s}
.secondary:hover{border-color:#98a2b3;background:#f9fafb;box-shadow:0 2px 6px rgba(16,24,40,.06)}:focus-visible{outline:3px solid #84adff;outline-offset:3px}
noscript p{margin:18px 0 0;color:#667085;font-size:13px}@media(max-width:480px){body{padding:16px}.password-card{padding:30px 22px;border-radius:16px}.mark{margin-bottom:20px}h1{font-size:22px}.intro{margin-bottom:26px}}
</style></head><body><main class="password-card"><div class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><rect x="5" y="10" width="14" height="10" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="15" r="1.2" fill="currentColor"/></svg></div><h1>此链接已开启密码访问</h1>
<p class="intro">输入访问密码，或使用钉钉账号继续</p>
<form id="password-form" action="/auth/password/verify" method="post" novalidate>
<label for="password">访问密码</label><input id="password" name="password" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="status" placeholder="请输入访问密码" autofocus>
<button id="submit" type="submit">打开链接</button></form>
<p id="status" role="status" aria-live="polite">${input.loginFailed ? "钉钉登录未完成，请输入访问密码或重新登录。" : ""}</p>
<div class="divider" aria-hidden="true">或</div><a class="secondary" href="${escapeAttribute(loginUrl)}">钉钉登录打开</a>
<noscript><p>请启用 JavaScript 后输入访问密码，或选择钉钉登录打开。</p></noscript>
</main><script nonce="${nonce}">
const input=${values};
const form=document.getElementById("password-form");
const password=document.getElementById("password");
const button=document.getElementById("submit");
const status=document.getElementById("status");
let pending=false;
form.addEventListener("submit",async event=>{
  event.preventDefault();
  if(pending)return;
  const value=password.value.trim();
  if(!value){status.textContent="请输入访问密码";password.setAttribute("aria-invalid","true");password.focus();return}
  pending=true;button.disabled=true;password.disabled=true;form.setAttribute("aria-busy","true");
  password.removeAttribute("aria-invalid");button.textContent="正在验证…";status.textContent="正在验证访问密码…";
  let navigating=false;
  try{
    const response=await fetch("/auth/password/verify",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({state:input.state,password:value})});
    if(response.status===404){password.value="";location.replace(input.returnPath);navigating=true;return}
    const result=await response.json();
    if(response.ok&&typeof result.redirectUrl==="string"){password.value="";status.textContent="验证成功，正在打开链接…";location.replace(result.redirectUrl);navigating=true;return}
    status.textContent=response.status===429?"尝试次数过多，请在 "+(response.headers.get("retry-after")||"60")+" 秒后重试。":response.status===401?"密码错误，请重试":typeof result.error==="string"?result.error:"暂时无法验证，请稍后重试";
    if(response.status===401)password.setAttribute("aria-invalid","true");
  }catch{status.textContent="网络连接失败，请检查网络后重试"}
  finally{if(!navigating){pending=false;button.disabled=false;password.disabled=false;button.textContent="打开链接";form.removeAttribute("aria-busy");password.focus()}}
});
</script></body></html>`);
}

function escapeAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
