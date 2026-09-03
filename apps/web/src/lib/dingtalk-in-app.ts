export interface DingTalkAuthorizationResult {
  code?: string;
}

export interface DingTalkBridge {
  requestAuthCode(input: {
    clientId: string;
    corpId: string;
    fail(error: unknown): void;
    success(result: DingTalkAuthorizationResult): void;
  }): void;
}

export interface FetchResponse {
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  ok: boolean;
}

export interface InAppLoginOptions {
  apiUrl: string;
  clientId?: string | undefined;
  corpId?: string | undefined;
  fetcher(input: string, init: RequestInit): Promise<FetchResponse>;
  returnPath: string;
  bridge: DingTalkBridge;
}

export async function completeDingTalkInAppLogin(options: InAppLoginOptions): Promise<string> {
  const started = await options.fetcher(`${options.apiUrl}/auth/internal/start`, {
    body: JSON.stringify({ returnPath: options.returnPath }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!started.ok) throw new Error("IN_APP_AUTH_START_FAILED");

  const payload = await started.json();
  if (!isAuthState(payload)) throw new Error("IN_APP_AUTH_START_FAILED");
  const code = await requestAuthCode(options.bridge, options.clientId, options.corpId);
  const completed = await options.fetcher(`${options.apiUrl}/auth/internal/complete`, {
    body: JSON.stringify({ code, state: payload.state }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const redirectUrl = completed.headers.get("location");
  if (!completed.ok || redirectUrl === null) throw new Error("IN_APP_AUTH_COMPLETE_FAILED");
  return redirectUrl;
}

export function readDingTalkBridge(value: unknown): DingTalkBridge | null {
  if (typeof value !== "object" || value === null) return null;
  const requestAuthCode = (value as Record<string, unknown>)["requestAuthCode"];
  return typeof requestAuthCode === "function" ? (value as DingTalkBridge) : null;
}

export function requestAuthCode(
  bridge: DingTalkBridge,
  clientId?: string | undefined,
  corpId?: string | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (clientId === undefined || corpId === undefined) {
      reject(new Error("IN_APP_AUTH_NOT_CONFIGURED"));
      return;
    }
    let settled = false;
    const succeed = (result: DingTalkAuthorizationResult) => {
      if (settled) return;
      settled = true;
      if (typeof result.code !== "string" || result.code.length === 0) {
        reject(new Error("IN_APP_AUTH_CODE_MISSING"));
        return;
      }
      resolve(result.code);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(new Error("IN_APP_AUTH_CODE_REJECTED"));
    };

    try {
      bridge.requestAuthCode({
        clientId,
        corpId,
        fail,
        success: succeed,
      });
    } catch {
      fail();
    }
  });
}

function isAuthState(value: unknown): value is { state: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)["state"] === "string"
  );
}
