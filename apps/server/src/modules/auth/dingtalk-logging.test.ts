import { describe, expect, it, vi } from "vitest";

import { logAuthorizationStep } from "./dingtalk-logging.js";

describe("DingTalk authorization logging", () => {
  it("emits safe success fields with the request trace id", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };

    logAuthorizationStep(logger, "trace_safe_123", {
      audience: "app",
      authFlow: "internal",
      durationMs: 17,
      httpStatus: 200,
      outcome: "succeeded",
      stage: "identity_lookup",
    });

    expect(logger.info).toHaveBeenCalledWith(
      {
        action: "dingtalk_authorization",
        audience: "app",
        auth_flow: "internal",
        duration_ms: 17,
        http_status: 200,
        outcome: "succeeded",
        stage: "identity_lookup",
        trace_id: "trace_safe_123",
      },
      "dingtalk authorization step",
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("uses warning severity and a sanitized internal failure category", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };

    logAuthorizationStep(logger, "trace_failure_123", {
      audience: "demo",
      authFlow: "external",
      failureReason: "provider_rejected",
      failureType: "AUTHORIZATION_DENIED",
      httpStatus: 403,
      outcome: "failed",
      stage: "authorization_complete",
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        failure_reason: "provider_rejected",
        failure_type: "AUTHORIZATION_DENIED",
        http_status: 403,
        trace_id: "trace_failure_123",
      }),
      "dingtalk authorization step",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("code");
    expect(logger.info).not.toHaveBeenCalled();
  });
});
