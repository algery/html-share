import { normalizeAccountContacts, type FeishuIdentity } from "@html-share/core";

const AUTHORIZATION_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const TOKEN_URL = "https://accounts.feishu.cn/oauth/v3/token";
const USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info";
const CONTACT_SCOPE = "contact:user.phone:readonly contact:user.email:readonly";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

type AuthorizationStage = "token_exchange" | "identity_lookup";
type FailureReason = "invalid_response" | "network_error" | "provider_rejected" | "tenant_mismatch";

export class FeishuAuthorizationError extends Error {
  constructor(
    readonly code: "AUTHORIZATION_DENIED" | "PROVIDER_UNAVAILABLE",
    readonly details?: {
      stage: AuthorizationStage;
      failureReason: FailureReason;
      httpStatus?: number;
    },
  ) {
    super(code);
    this.name = "FeishuAuthorizationError";
  }
}

export interface FeishuAuthorizationClient {
  createAuthorizationUrl(input: {
    callbackUrl: string;
    state: string;
    codeChallenge?: string;
  }): string;
  exchangeAuthorizationCode(input: {
    code: string;
    callbackUrl: string;
    codeVerifier?: string;
  }): Promise<FeishuIdentity>;
}

export function createFeishuClient(options: {
  appId: string;
  appSecret: string;
  tenantKey: string;
  fetcher?: typeof fetch;
}): FeishuAuthorizationClient {
  const fetcher = options.fetcher ?? fetch;
  return {
    createAuthorizationUrl({ callbackUrl, state, codeChallenge }) {
      const url = new URL(AUTHORIZATION_URL);
      url.search = new URLSearchParams({
        client_id: options.appId,
        redirect_uri: callbackUrl,
        response_type: "code",
        scope: CONTACT_SCOPE,
        state,
      }).toString();
      if (codeChallenge !== undefined) {
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
      }
      return url.toString();
    },
    async exchangeAuthorizationCode({ code, callbackUrl, codeVerifier }) {
      const tokenPayload = await requestPayload(fetcher, TOKEN_URL, "token_exchange", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: options.appId,
          client_secret: options.appSecret,
          code,
          redirect_uri: callbackUrl,
          ...(codeVerifier === undefined ? {} : { code_verifier: codeVerifier }),
        }),
      });
      const token = textValue(tokenPayload["access_token"]);
      if (!token || tokenPayload["token_type"] !== "Bearer") {
        throw invalidResponse("token_exchange");
      }
      const identityPayload = await requestPayload(fetcher, USER_INFO_URL, "identity_lookup", {
        headers: { authorization: `Bearer ${token}` },
      });
      const data = identityPayload["data"];
      if (!isRecord(data)) throw invalidResponse("identity_lookup");
      const openId = stableIdentifier(data["open_id"]);
      const tenantKey = stableIdentifier(data["tenant_key"]);
      const displayName = textValue(data["name"]);
      if (!openId || !tenantKey || !displayName) throw invalidResponse("identity_lookup");
      if (tenantKey !== options.tenantKey) {
        throw new FeishuAuthorizationError("AUTHORIZATION_DENIED", {
          stage: "identity_lookup",
          failureReason: "tenant_mismatch",
        });
      }
      // email and enterprise_email are distinct fields/scopes. Never substitute the latter.
      const contacts = normalizeAccountContacts({
        ...(textValue(data["mobile"]) ? { phone: String(data["mobile"]) } : {}),
        ...(textValue(data["email"]) ? { email: String(data["email"]) } : {}),
      });
      return {
        feishuAppId: options.appId,
        feishuTenantKey: tenantKey,
        feishuOpenId: openId,
        displayName,
        ...(contacts.phone === null ? {} : { phone: contacts.phone }),
        ...(contacts.email === null ? {} : { email: contacts.email }),
      };
    },
  };
}

async function requestPayload(
  fetcher: typeof fetch,
  url: string,
  stage: AuthorizationStage,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("upstream_timeout"));
        }, REQUEST_TIMEOUT_MS);
      }),
      (async () => {
        const response = await fetcher(url, {
          ...init,
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          throw new FeishuAuthorizationError(
            response.status === 429 || response.status >= 500
              ? "PROVIDER_UNAVAILABLE"
              : "AUTHORIZATION_DENIED",
            { stage, failureReason: "provider_rejected", httpStatus: response.status },
          );
        }
        const payload = await readBoundedJson(response, controller.signal);
        if (!isRecord(payload) || typeof payload["code"] !== "number") throw invalidResponse(stage);
        if (payload["code"] !== 0) {
          throw new FeishuAuthorizationError(
            payload["code"] === 20050 || payload["code"] === 20072
              ? "PROVIDER_UNAVAILABLE"
              : "AUTHORIZATION_DENIED",
            { stage, failureReason: "provider_rejected", httpStatus: response.status },
          );
        }
        return payload;
      })(),
    ]);
  } catch (error) {
    if (error instanceof FeishuAuthorizationError) throw error;
    throw new FeishuAuthorizationError("PROVIDER_UNAVAILABLE", {
      stage,
      failureReason: "network_error",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        cancel();
        return undefined;
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      return undefined;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function invalidResponse(stage: AuthorizationStage) {
  return new FeishuAuthorizationError("PROVIDER_UNAVAILABLE", {
    stage,
    failureReason: "invalid_response",
  });
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stableIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,255}$/.test(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
