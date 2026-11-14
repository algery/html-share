import { EnvironmentValidationError } from "./database-environment.js";

export type FeishuEnvironment =
  | { FEISHU_ENABLED: false }
  | {
      FEISHU_ENABLED: true;
      FEISHU_APP_ID: string;
      FEISHU_APP_SECRET: string;
      FEISHU_TENANT_KEY: string;
      FEISHU_TOKEN_API_VERSION: "v2" | "v3";
    };

export function readFeishuEnv(environment: Record<string, string | undefined>): FeishuEnvironment {
  const enabled = environment["FEISHU_ENABLED"] ?? "false";
  if (enabled !== "true" && enabled !== "false") {
    throw new EnvironmentValidationError(["FEISHU_ENABLED"]);
  }
  const tokenApiVersion = environment["FEISHU_TOKEN_API_VERSION"] ?? "v3";
  if (tokenApiVersion !== "v2" && tokenApiVersion !== "v3") {
    throw new EnvironmentValidationError(["FEISHU_TOKEN_API_VERSION"]);
  }
  if (enabled === "false") return { FEISHU_ENABLED: false };

  const appId = environment["FEISHU_APP_ID"]?.trim();
  const appSecret = environment["FEISHU_APP_SECRET"]?.trim();
  const tenantKey = environment["FEISHU_TENANT_KEY"]?.trim();
  if (!appId || !appSecret || !tenantKey) {
    throw new EnvironmentValidationError([
      ...(!appId ? ["FEISHU_APP_ID"] : []),
      ...(!appSecret ? ["FEISHU_APP_SECRET"] : []),
      ...(!tenantKey ? ["FEISHU_TENANT_KEY"] : []),
    ]);
  }
  return {
    FEISHU_ENABLED: true,
    FEISHU_APP_ID: appId,
    FEISHU_APP_SECRET: appSecret,
    FEISHU_TENANT_KEY: tenantKey,
    FEISHU_TOKEN_API_VERSION: tokenApiVersion,
  };
}
