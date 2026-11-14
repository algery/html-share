import { normalizeAccountContacts, type DingTalkIdentity } from "@html-share/core";

import { requestAuthorizationJson } from "./client-http.js";
import { simulatorIdentity } from "./directory-simulator.js";

export class DingTalkAuthorizationError extends Error {
  constructor(
    readonly code: "AUTHORIZATION_DENIED" | "PROVIDER_UNAVAILABLE",
    readonly details?: DingTalkAuthorizationErrorDetails,
  ) {
    super(code);
    this.name = "DingTalkAuthorizationError";
  }
}

export type DingTalkAuthorizationStage =
  "identity_lookup" | "simulator_identity" | "token_exchange";

export type DingTalkAuthorizationFailureReason =
  "invalid_response" | "network_error" | "provider_rejected";

export interface DingTalkAuthorizationDiagnostic {
  durationMs?: number;
  failureReason?: DingTalkAuthorizationFailureReason;
  httpStatus?: number;
  outcome: "failed" | "started" | "succeeded";
  stage: DingTalkAuthorizationStage;
}

export interface DingTalkAuthorizationErrorDetails {
  failureReason: DingTalkAuthorizationFailureReason;
  httpStatus?: number;
  stage: DingTalkAuthorizationStage;
}

export type DingTalkAuthorizationDiagnosticReporter = (
  diagnostic: DingTalkAuthorizationDiagnostic,
) => void;

export interface DingTalkAuthorizationClient {
  createExternalAuthorizationUrl(input: { callbackUrl: string; state: string }): string;
  exchangeExternalAuthorizationCode(
    code: string,
    reportDiagnostic?: DingTalkAuthorizationDiagnosticReporter,
  ): Promise<DingTalkIdentity>;
  exchangeInternalAuthorizationCode(
    code: string,
    reportDiagnostic?: DingTalkAuthorizationDiagnosticReporter,
  ): Promise<DingTalkIdentity>;
}

export interface LiveDingTalkClientOptions {
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
  externalAuthorizeUrl: string;
}

const IDENTITY_AUTHORIZATION_SCOPE = "openid Contact.User.Read";

export function createSimulatorDingTalkClient(): DingTalkAuthorizationClient {
  return {
    createExternalAuthorizationUrl({ callbackUrl, state }) {
      const callback = new URL(callbackUrl);
      callback.searchParams.set("code", "simulator-external-member");
      callback.searchParams.set("state", state);
      return callback.toString();
    },
    exchangeExternalAuthorizationCode(code, reportDiagnostic) {
      return resolveSimulatorIdentity(code, reportDiagnostic);
    },
    exchangeInternalAuthorizationCode(code, reportDiagnostic) {
      return resolveSimulatorIdentity(code, reportDiagnostic);
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
      authorizationUrl.searchParams.set("scope", IDENTITY_AUTHORIZATION_SCOPE);
      authorizationUrl.searchParams.set("prompt", "consent");
      authorizationUrl.searchParams.set("state", state);
      return authorizationUrl.toString();
    },
    exchangeExternalAuthorizationCode(code, reportDiagnostic) {
      return exchangeCodeForIdentity(options, code, reportDiagnostic);
    },
    exchangeInternalAuthorizationCode(code, reportDiagnostic) {
      return exchangeCodeForIdentity(options, code, reportDiagnostic);
    },
  };
}

async function resolveSimulatorIdentity(
  code: string,
  reportDiagnostic?: DingTalkAuthorizationDiagnosticReporter,
): Promise<DingTalkIdentity> {
  const startedAt = performance.now();
  reportSafely(reportDiagnostic, { outcome: "started", stage: "simulator_identity" });
  const identity = simulatorIdentity(code);
  if (identity) {
    reportSafely(reportDiagnostic, {
      durationMs: elapsedMilliseconds(startedAt),
      outcome: "succeeded",
      stage: "simulator_identity",
    });
    return identity;
  }
  const details = {
    failureReason: "provider_rejected",
    stage: "simulator_identity",
  } as const;
  reportSafely(reportDiagnostic, {
    durationMs: elapsedMilliseconds(startedAt),
    failureReason: details.failureReason,
    outcome: "failed",
    stage: details.stage,
  });
  throw new DingTalkAuthorizationError("AUTHORIZATION_DENIED", details);
}

async function exchangeCodeForIdentity(
  options: LiveDingTalkClientOptions,
  code: string,
  reportDiagnostic?: DingTalkAuthorizationDiagnosticReporter,
): Promise<DingTalkIdentity> {
  const token = await requestDingTalkValue({
    readValue: readAccessToken,
    ...(reportDiagnostic === undefined ? {} : { reportDiagnostic }),
    request: (signal) =>
      fetch(new URL("/v1.0/oauth2/userAccessToken", options.apiBaseUrl), {
        signal,
        redirect: "error",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: options.clientId,
          clientSecret: options.clientSecret,
          code,
          grantType: "authorization_code",
        }),
      }),
    stage: "token_exchange",
  });
  return requestDingTalkValue({
    readValue: readIdentity,
    ...(reportDiagnostic === undefined ? {} : { reportDiagnostic }),
    request: (signal) =>
      fetch(new URL("/v1.0/contact/users/me", options.apiBaseUrl), {
        signal,
        redirect: "error",
        headers: { "x-acs-dingtalk-access-token": token },
      }),
    stage: "identity_lookup",
  });
}

async function requestDingTalkValue<T>(input: {
  readValue: (payload: unknown) => T | undefined;
  reportDiagnostic?: DingTalkAuthorizationDiagnosticReporter;
  request: (signal: AbortSignal) => Promise<Response>;
  stage: DingTalkAuthorizationStage;
}): Promise<T> {
  const startedAt = performance.now();
  reportSafely(input.reportDiagnostic, { outcome: "started", stage: input.stage });
  try {
    const { response, payload } = await requestAuthorizationJson(input.request);
    if (!response.ok) {
      const details = {
        failureReason: "provider_rejected",
        httpStatus: response.status,
        stage: input.stage,
      } as const;
      reportSafely(input.reportDiagnostic, {
        durationMs: elapsedMilliseconds(startedAt),
        ...details,
        outcome: "failed",
      });
      throw new DingTalkAuthorizationError(
        response.status === 429 || response.status >= 500
          ? "PROVIDER_UNAVAILABLE"
          : "AUTHORIZATION_DENIED",
        details,
      );
    }
    const value = input.readValue(payload);
    if (value === undefined) {
      const details = {
        failureReason: "invalid_response",
        httpStatus: response.status,
        stage: input.stage,
      } as const;
      reportSafely(input.reportDiagnostic, {
        durationMs: elapsedMilliseconds(startedAt),
        ...details,
        outcome: "failed",
      });
      throw new DingTalkAuthorizationError("PROVIDER_UNAVAILABLE", details);
    }
    reportSafely(input.reportDiagnostic, {
      durationMs: elapsedMilliseconds(startedAt),
      httpStatus: response.status,
      outcome: "succeeded",
      stage: input.stage,
    });
    return value;
  } catch (error) {
    if (error instanceof DingTalkAuthorizationError) {
      throw error;
    }
    const details = { failureReason: "network_error", stage: input.stage } as const;
    reportSafely(input.reportDiagnostic, {
      durationMs: elapsedMilliseconds(startedAt),
      ...details,
      outcome: "failed",
    });
    throw new DingTalkAuthorizationError("PROVIDER_UNAVAILABLE", details);
  }
}

function readAccessToken(payload: unknown) {
  if (
    !isRecord(payload) ||
    typeof payload["accessToken"] !== "string" ||
    payload["accessToken"].length === 0
  ) {
    return undefined;
  }
  return payload["accessToken"];
}

function readIdentity(payload: unknown): DingTalkIdentity | undefined {
  if (
    !isRecord(payload) ||
    typeof payload["openId"] !== "string" ||
    payload["openId"].length === 0 ||
    typeof payload["nick"] !== "string" ||
    payload["nick"].length === 0
  ) {
    return undefined;
  }
  const unionId = payload["unionId"];
  const mobile = typeof payload["mobile"] === "string" ? payload["mobile"].trim() : "";
  const stateCode = payload["stateCode"];
  const phone =
    mobile &&
    !mobile.startsWith("+") &&
    typeof stateCode === "string" &&
    /^\+?[1-9]\d{0,2}$/.test(stateCode)
      ? `+${stateCode.replace(/^\+/, "")}${mobile}`
      : mobile;
  const contacts = normalizeAccountContacts({
    phone,
    ...(typeof payload["email"] === "string" ? { email: payload["email"] } : {}),
  });
  return {
    dingtalkUserId: payload["openId"],
    displayName: payload["nick"],
    ...(typeof unionId === "string" && unionId.trim() ? { dingtalkUnionId: unionId } : {}),
    ...(contacts.phone === null ? {} : { phone: contacts.phone }),
    ...(contacts.email === null ? {} : { email: contacts.email }),
  };
}

function elapsedMilliseconds(startedAt: number) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function reportSafely(
  reporter: DingTalkAuthorizationDiagnosticReporter | undefined,
  diagnostic: DingTalkAuthorizationDiagnostic,
) {
  try {
    reporter?.(diagnostic);
  } catch {
    // Diagnostic sinks must never change the authorization result.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
