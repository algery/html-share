import type { FastifyReply } from "fastify";

export function sendContentLoginPage(
  reply: FastifyReply,
  input: {
    clientId?: string;
    corpId?: string;
    externalAuthorizationUrl: string;
    state: string;
  },
) {
  const externalUrl = input.externalAuthorizationUrl
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const values = JSON.stringify(input).replaceAll("<", "\\u003c");
  return reply
    .header("cache-control", "no-store")
    .header(
      "content-security-policy",
      "base-uri 'none'; default-src 'none'; form-action 'self'; connect-src 'self'; script-src 'unsafe-inline'",
    )
    .header("content-type", "text/html; charset=utf-8")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("x-robots-tag", "noindex")
    .send(
      `<!doctype html><meta charset="utf-8"><title>正在验证组织身份</title><p id="status">正在验证组织身份…</p><noscript><a href="${externalUrl}">继续钉钉登录</a></noscript><script>const input=${values};const status=document.getElementById("status");const fallback=()=>location.replace(input.externalAuthorizationUrl);const fail=()=>{status.textContent="无法完成钉钉免登，正在跳转授权页面…";fallback()};const navigate=url=>{const target=new URL(url,location.origin);if(target.origin!==location.origin)throw new Error("invalid redirect");location.replace(target.href)};const complete=async code=>{try{const response=await fetch("/auth/internal/complete",{method:"POST",mode:"cors",credentials:"same-origin",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify({code,state:input.state})});if(response.redirected||response.status===404){navigate(response.url);return}const result=await response.json();if(!response.ok||typeof result.redirectUrl!=="string")throw new Error("authorization failed");navigate(result.redirectUrl)}catch{fail()}};const bridge=window.dd;if(typeof input.clientId!=="string"||typeof input.corpId!=="string"||bridge===undefined||typeof bridge.requestAuthCode!=="function"){fallback()}else{bridge.requestAuthCode({clientId:input.clientId,corpId:input.corpId,success:result=>typeof result.code==="string"&&result.code.length>0?void complete(result.code):fail(),fail})}</script>`,
    );
}
