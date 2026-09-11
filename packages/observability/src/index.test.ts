import { describe, expect, it } from "vitest";

import { createTelemetry, createTraceId, redactLogValue } from "./index.js";

describe("observability primitives", () => {
  it("accepts only safe trace ids and otherwise generates an opaque id", () => {
    expect(createTraceId("trace_0123456789")).toBe("trace_0123456789");
    expect(createTraceId("bad trace id")).not.toBe("bad trace id");
    expect(createTraceId("<script>alert(1)</script>")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("redacts credentials and file bodies instead of retaining a body prefix", () => {
    const body = "x".repeat(300);
    expect(
      redactLogValue({
        authorization: "Bearer secret",
        nested: { fileBody: body, requestPayload: body, token: "secret" },
      }),
    ).toEqual({
      authorization: "[REDACTED]",
      nested: { fileBody: "[REDACTED]", requestPayload: "[REDACTED]", token: "[REDACTED]" },
    });
  });

  it("redacts every code-shaped field and keeps non-credential diagnostic fields", () => {
    expect(
      redactLogValue({
        authorization_code: "one-time-secret",
        code: "one-time-secret",
        error_code: "AUTHORIZATION_DENIED",
        failure_type: "AUTHORIZATION_DENIED",
        http_status: 401,
        provider_error_code: "invalidClientSecret",
        status_code: 401,
      }),
    ).toEqual({
      authorization_code: "[REDACTED]",
      code: "[REDACTED]",
      error_code: "[REDACTED]",
      failure_type: "AUTHORIZATION_DENIED",
      http_status: 401,
      provider_error_code: "[REDACTED]",
      status_code: "[REDACTED]",
    });
  });

  it("redacts password results, grants, signed states and submitted payloads", () => {
    expect(
      redactLogValue({
        access_password: "sample",
        passwordHash: "sample",
        grantToken: "sample",
        password_return: "sample",
        body: { password: "sample" },
      }),
    ).toEqual({
      access_password: "[REDACTED]",
      passwordHash: "[REDACTED]",
      grantToken: "[REDACTED]",
      password_return: "[REDACTED]",
      body: "[REDACTED]",
    });
  });

  it("counts failures and latency without retaining request data", () => {
    const telemetry = createTelemetry();
    telemetry.record({ milliseconds: 15, name: "publish" });
    telemetry.record({ failed: true, milliseconds: 25, name: "publish" });
    expect(telemetry.snapshot()).toEqual({
      publish: { count: 2, failures: 1, maxMilliseconds: 25, totalMilliseconds: 40 },
    });
  });
});
