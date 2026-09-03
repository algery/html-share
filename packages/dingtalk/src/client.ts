import type { DingTalkIdentity } from "@html-share/core";

export class DingTalkAuthorizationError extends Error {
  constructor(readonly code: "AUTHORIZATION_DENIED" | "PROVIDER_UNAVAILABLE") {
    super(code);
    this.name = "DingTalkAuthorizationError";
  }
}

export interface DingTalkAuthorizationClient {
  createExternalAuthorizationUrl(input: { callbackUrl: string; state: string }): string;
  exchangeExternalAuthorizationCode(code: string): Promise<DingTalkIdentity>;
  exchangeInternalAuthorizationCode(code: string): Promise<DingTalkIdentity>;
}

export interface LiveDingTalkClientOptions {
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
  externalAuthorizeUrl: string;
}

export function createSimulatorDingTalkClient(): DingTalkAuthorizationClient {
  return {
    createExternalAuthorizationUrl({ callbackUrl, state }) {
      const callback = new URL(callbackUrl);
      callback.searchParams.set("code", "simulator-external-member");
      callback.searchParams.set("state", state);
      return callback.toString();
    },
    exchangeExternalAuthorizationCode(code) {
      return resolveSimulatorIdentity(code);
    },
    exchangeInternalAuthorizationCode(code) {
      return resolveSimulatorIdentity(code);
    },
  };
}

export function createLiveDingTalkClient(
  options: LiveDingTalkClientOptions,
): DingTalkAuthorizationClient {
  return {
    createExternalAuthorizationUrl({ callbackUrl, state }) {
      const authorizationUrl = new URL(options.externalAuthorizeUrl);
      authorizationUrl.searchParams.set("client_id", options.clientId);
      authorizationUrl.searchParams.set("redirect_uri", callbackUrl);
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set("scope", "openid");
      authorizationUrl.searchParams.set("state", state);
      return authorizationUrl.toString();
    },
    exchangeExternalAuthorizationCode(code) {
      return exchangeCodeForIdentity(options, code);
    },
    exchangeInternalAuthorizationCode(code) {
      return exchangeCodeForIdentity(options, code);
    },
  };
}

async function resolveSimulatorIdentity(code: string): Promise<DingTalkIdentity> {
  if (code === "simulator-member" || code === "simulator-external-member") {
    return { dingtalkUserId: "simulator-user-001", displayName: "模拟组织成员" };
  }
  throw new DingTalkAuthorizationError("AUTHORIZATION_DENIED");
}

async function exchangeCodeForIdentity(
  options: LiveDingTalkClientOptions,
  code: string,
): Promise<DingTalkIdentity> {
  try {
    const tokenResponse = await fetch(new URL("/v1.0/oauth2/userAccessToken", options.apiBaseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        code,
        grantType: "authorization_code",
      }),
    });
    const token = await readAccessToken(tokenResponse);
    const userResponse = await fetch(new URL("/v1.0/contact/users/me", options.apiBaseUrl), {
      headers: { "x-acs-dingtalk-access-token": token },
    });
    return await readIdentity(userResponse);
  } catch (error) {
    if (error instanceof DingTalkAuthorizationError) {
      throw error;
    }
    throw new DingTalkAuthorizationError("PROVIDER_UNAVAILABLE");
  }
}

async function readAccessToken(response: Response) {
  if (!response.ok) {
    throw new DingTalkAuthorizationError("AUTHORIZATION_DENIED");
  }
  const payload = await response.json();
  if (
    !isRecord(payload) ||
    typeof payload["accessToken"] !== "string" ||
    payload["accessToken"].length === 0
  ) {
    throw new DingTalkAuthorizationError("PROVIDER_UNAVAILABLE");
  }
  return payload["accessToken"];
}

async function readIdentity(response: Response): Promise<DingTalkIdentity> {
  if (!response.ok) {
    throw new DingTalkAuthorizationError("AUTHORIZATION_DENIED");
  }
  const payload = await response.json();
  if (
    !isRecord(payload) ||
    typeof payload["openId"] !== "string" ||
    payload["openId"].length === 0 ||
    typeof payload["nick"] !== "string" ||
    payload["nick"].length === 0
  ) {
    throw new DingTalkAuthorizationError("PROVIDER_UNAVAILABLE");
  }
  return { dingtalkUserId: payload["openId"], displayName: payload["nick"] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
