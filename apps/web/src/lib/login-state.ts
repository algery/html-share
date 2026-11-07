export interface LoginState {
  description: string;
  title: string;
  tone: "default" | "error" | "success";
}

const LOGIN_STATES: Record<string, LoginState> = {
  denied: {
    description: "你不属于可访问组织，平台没有建立登录态，也不会返回 Demo 内容。",
    title: "无访问权限",
    tone: "error",
  },
  error: {
    description: "无法完成钉钉授权，请返回后重试。若持续失败，请携带诊断编号联系管理员。",
    title: "授权未完成",
    tone: "error",
  },
  success: {
    description: "组织身份已验证，登录态将在 8 小时后自动失效。",
    title: "验证完成",
    tone: "success",
  },
  verifying: {
    description: "正在验证组织身份，请不要关闭此页面。",
    title: "正在验证组织身份",
    tone: "default",
  },
};

const DEFAULT_STATE: LoginState = {
  description: "在钉钉中会优先使用免登；外部浏览器会跳转到钉钉授权。",
  title: "使用钉钉登录 Demo Share",
  tone: "default",
};

export function resolveLoginState(value: unknown): LoginState {
  return typeof value === "string" ? (LOGIN_STATES[value] ?? DEFAULT_STATE) : DEFAULT_STATE;
}
