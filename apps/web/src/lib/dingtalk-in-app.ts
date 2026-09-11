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
  status?: number;
}

export interface DingTalkInAppDiagnostic {
  outcome: "failed" | "started" | "succeeded";
  stage: "auth_code_request" | "complete_request" | "start_request";
  statusCode?: number;
  traceId?: string;
}

export interface InAppLoginOptions {
  apiUrl: string;
  clientId?: string | undefined;
  corpId?: string | undefined;
  fetcher(input: string, init: RequestInit): Promise<FetchResponse>;
  reportDiagnostic?(diagnostic: DingTalkInAppDiagnostic): void;
  returnPath: string;
  bridge: DingTalkBridge;
}

export async function completeDingTalkInAppLogin(options: InAppLoginOptions): Promise<string> {
  reportSafely(options.reportDiagnostic, { outcome: "started", stage: "start_request" });
  let started: FetchResponse;
  try {
    started = await options.fetcher(`${options.apiUrl}/auth/internal/start`, {
      body: JSON.stringify({ returnPath: options.returnPath }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch {
    reportSafely(options.reportDiagnostic, {
      outcome: "failed",
      stage: "start_request",
    });
    throw new Error("IN_APP_AUTH_START_FAILED");
  }
  const startTraceId = readTraceId(started);
  if (!started.ok) {
    reportSafely(options.reportDiagnostic, {
      outcome: "failed",
      stage: "start_request",
      ...(started.status === undefined ? {} : { statusCode: started.status }),
      ...(startTraceId === undefined ? {} : { traceId: startTraceId }),
    });
    throw new Error("IN_APP_AUTH_START_FAILED");
  }

  const payload = await readJsonResponse(started);
  if (!isAuthState(payload)) {
    reportSafely(options.reportDiagnostic, {
      outcome: "failed",
      stage: "start_request",
      ...(started.status === undefined ? {} : { statusCode: started.status }),
      ...(startTraceId === undefined ? {} : { traceId: startTraceId }),
    });
    throw new Error("IN_APP_AUTH_START_FAILED");
  }
  reportSafely(options.reportDiagnostic, {
    outcome: "succeeded",
    stage: "start_request",
    ...(started.status === undefined ? {} : { statusCode: started.status }),
    ...(startTraceId === undefined ? {} : { traceId: startTraceId }),
  });

  reportSafely(options.reportDiagnostic, { outcome: "started", stage: "auth_code_request" });
  let code: string;
  try {
    code = await requestAuthCode(options.bridge, options.clientId, options.corpId);
  } catch {
    reportSafely(options.reportDiagnostic, {
      outcome: "failed",
      stage: "auth_code_request",
    });
    throw new Error("IN_APP_AUTH_CODE_FAILED");
  }
  reportSafely(options.reportDiagnostic, { outcome: "succeeded", stage: "auth_code_request" });

  reportSafely(options.reportDiagnostic, { outcome: "started", stage: "complete_request" });
  let completed: FetchResponse;
  try {
    completed = await options.fetcher(`${options.apiUrl}/auth/internal/complete`, {
      body: JSON.stringify({ code, state: payload.state }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch {
    reportSafely(options.reportDiagnostic, {
      outcome: "failed",
      stage: "complete_request",
    });
    throw new Error("IN_APP_AUTH_COMPLETE_FAILED");
  }
  const completedTraceId = readTraceId(completed);
  const completedPayload = await readJsonResponse(completed);
  if (!completed.ok || !isRedirectPayload(completedPayload)) {
    reportSafely(options.reportDiagnostic, {
      outcome: "failed",
      stage: "complete_request",
      ...(completed.status === undefined ? {} : { statusCode: completed.status }),
      ...(completedTraceId === undefined ? {} : { traceId: completedTraceId }),
    });
    throw new Error("IN_APP_AUTH_COMPLETE_FAILED");
  }
  reportSafely(options.reportDiagnostic, {
    outcome: "succeeded",
    stage: "complete_request",
    ...(completed.status === undefined ? {} : { statusCode: completed.status }),
    ...(completedTraceId === undefined ? {} : { traceId: completedTraceId }),
  });
  return completedPayload.redirectUrl;
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

function isRedirectPayload(value: unknown): value is { redirectUrl: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)["redirectUrl"] === "string"
  );
}

function readTraceId(response: FetchResponse) {
  const value = response.headers.get("x-trace-id");
  return value !== null && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
}

async function readJsonResponse(response: FetchResponse) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function reportSafely(
  reporter: InAppLoginOptions["reportDiagnostic"],
  diagnostic: DingTalkInAppDiagnostic,
) {
  try {
    reporter?.(diagnostic);
  } catch {
    // Browser diagnostics must never change the login result.
  }
}
