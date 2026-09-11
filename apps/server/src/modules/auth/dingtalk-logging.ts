import type { SessionAudience } from "@html-share/core";
import { redactLogValue } from "@html-share/observability";

interface AuthorizationLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export interface DingTalkAuthorizationLogInput {
  audience: SessionAudience;
  authFlow: "external" | "internal";
  durationMs?: number;
  failureReason?: string;
  failureType?: string;
  httpStatus?: number;
  outcome: "failed" | "started" | "succeeded";
  stage: string;
}

export function logAuthorizationStep(
  logger: AuthorizationLogger,
  traceId: string,
  input: DingTalkAuthorizationLogInput,
) {
  const fields = redactLogValue({
    action: "dingtalk_authorization",
    audience: input.audience,
    auth_flow: input.authFlow,
    ...(input.durationMs === undefined ? {} : { duration_ms: input.durationMs }),
    ...(input.failureReason === undefined ? {} : { failure_reason: input.failureReason }),
    ...(input.failureType === undefined ? {} : { failure_type: input.failureType }),
    ...(input.httpStatus === undefined ? {} : { http_status: input.httpStatus }),
    outcome: input.outcome,
    stage: input.stage,
    trace_id: traceId,
  }) as object;
  if (input.outcome === "failed") {
    logger.warn(fields, "dingtalk authorization step");
    return;
  }
  logger.info(fields, "dingtalk authorization step");
}
