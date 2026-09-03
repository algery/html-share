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
  const values = JSON.stringify(input).replaceAll("<", "\\u003c");
  return reply
    .header("cache-control", "no-store")
    .header(
      "content-security-policy",
      "base-uri 'none'; default-src 'none'; form-action 'self'; script-src 'unsafe-inline'",
    )
    .header("content-type", "text/html; charset=utf-8")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("x-robots-tag", "noindex")
    .send(
      `<!doctype html><meta charset="utf-8"><title>正在验证组织身份</title><p id="status">正在验证组织身份…</p><script>const input=${values};const status=document.getElementById("status");const fallback=()=>location.replace(input.externalAuthorizationUrl);const fail=()=>{status.textContent="无法完成钉钉免登，正在跳转授权页面…";fallback()};const complete=code=>{const form=document.createElement("form");form.action="/auth/internal/complete";form.method="post";for(const[name,value]of Object.entries({code,state:input.state})){const field=document.createElement("input");field.name=name;field.type="hidden";field.value=value;form.append(field)}document.body.append(form);form.submit()};const bridge=window.dd;if(typeof input.clientId!=="string"||typeof input.corpId!=="string"||bridge===undefined||typeof bridge.requestAuthCode!=="function"){fallback()}else{bridge.requestAuthCode({clientId:input.clientId,corpId:input.corpId,success:result=>typeof result.code==="string"&&result.code.length>0?void complete(result.code):fail(),fail})}</script>`,
    );
}
