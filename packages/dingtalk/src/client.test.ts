import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLiveDingTalkClient,
  createSimulatorDingTalkClient,
  type DingTalkAuthorizationDiagnostic,
} from "./client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("live DingTalk authorization client", () => {
  const client = () =>
    createLiveDingTalkClient({
      apiBaseUrl: "https://api.dingtalk.com",
      clientId: "public-client-id",
      clientSecret: "test-secret-not-output",
      externalAuthorizeUrl: "https://login.dingtalk.com/oauth2/auth",
    });

  it("creates an external authorization URL and exchanges a valid code", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: "provider-access-token" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ nick: "成员", openId: "ding-user-1" })));
    vi.stubGlobal("fetch", fetcher);

    const authorizationUrl = new URL(
      client().createExternalAuthorizationUrl({
        callbackUrl: "https://app.example.com/auth/callback",
        state: "signed-state",
      }),
    );
    const diagnostics: DingTalkAuthorizationDiagnostic[] = [];
    const identity = await client().exchangeExternalAuthorizationCode(
      "authorization-code",
      (diagnostic) => diagnostics.push(diagnostic),
    );

    expect(authorizationUrl.searchParams.get("client_id")).toBe("public-client-id");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/auth/callback",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe("openid Contact.User.Read");
    expect(authorizationUrl.searchParams.get("prompt")).toBe("consent");
    expect(authorizationUrl.searchParams.get("state")).toBe("signed-state");
    expect(identity).toEqual({ dingtalkUserId: "ding-user-1", displayName: "成员" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      headers: { "x-acs-dingtalk-access-token": "provider-access-token" },
    });
    expect(diagnostics).toEqual([
      { outcome: "started", stage: "token_exchange" },
      expect.objectContaining({
        httpStatus: 200,
        outcome: "succeeded",
        stage: "token_exchange",
      }),
      { outcome: "started", stage: "identity_lookup" },
      expect.objectContaining({
        httpStatus: 200,
        outcome: "succeeded",
        stage: "identity_lookup",
      }),
    ]);
  });

  it("reports a provider rejection without exposing response details or credentials", async () => {
    const diagnostics: DingTalkAuthorizationDiagnostic[] = [];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ accessToken: "must-not-appear", code: "invalidClientSecret" }),
            { status: 401 },
          ),
        ),
    );

    await expect(
      client().exchangeInternalAuthorizationCode("rejected-code", (diagnostic) =>
        diagnostics.push(diagnostic),
      ),
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_DENIED",
      details: {
        failureReason: "provider_rejected",
        httpStatus: 401,
        stage: "token_exchange",
      },
      message: "AUTHORIZATION_DENIED",
    });
    expect(diagnostics).toEqual([
      { outcome: "started", stage: "token_exchange" },
      expect.objectContaining({
        failureReason: "provider_rejected",
        httpStatus: 401,
        outcome: "failed",
        stage: "token_exchange",
      }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("must-not-appear");
    expect(JSON.stringify(diagnostics)).not.toContain("rejected-code");
  });

  it("distinguishes malformed success responses from provider rejections", async () => {
    const diagnostics: DingTalkAuthorizationDiagnostic[] = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({}))));

    await expect(
      client().exchangeInternalAuthorizationCode("one-time-code", (diagnostic) =>
        diagnostics.push(diagnostic),
      ),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: {
        failureReason: "invalid_response",
        httpStatus: 200,
        stage: "token_exchange",
      },
    });
    expect(diagnostics).toEqual([
      { outcome: "started", stage: "token_exchange" },
      expect.objectContaining({
        failureReason: "invalid_response",
        httpStatus: 200,
        outcome: "failed",
        stage: "token_exchange",
      }),
    ]);
  });

  it("reports network failures at the failing stage", async () => {
    const diagnostics: DingTalkAuthorizationDiagnostic[] = [];
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket details")));

    await expect(
      client().exchangeExternalAuthorizationCode("one-time-code", (diagnostic) =>
        diagnostics.push(diagnostic),
      ),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: {
        failureReason: "network_error",
        stage: "token_exchange",
      },
    });
    expect(diagnostics).toEqual([
      { outcome: "started", stage: "token_exchange" },
      expect.objectContaining({
        failureReason: "network_error",
        outcome: "failed",
        stage: "token_exchange",
      }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("socket details");
  });

  it("does not let a diagnostic sink failure break authorization", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: "provider-token" })))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ nick: "成员", openId: "ding-user-1" })),
        ),
    );

    await expect(
      client().exchangeExternalAuthorizationCode("one-time-code", () => {
        throw new Error("diagnostic sink unavailable");
      }),
    ).resolves.toEqual({ dingtalkUserId: "ding-user-1", displayName: "成员" });
  });

  it("never copies an upstream error-code field into diagnostics", async () => {
    const diagnostics: DingTalkAuthorizationDiagnostic[] = [];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: "secret value with spaces" }), { status: 403 }),
        ),
    );

    await expect(
      client().exchangeInternalAuthorizationCode("rejected-code", (diagnostic) =>
        diagnostics.push(diagnostic),
      ),
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_DENIED",
      details: {
        failureReason: "provider_rejected",
        httpStatus: 403,
        stage: "token_exchange",
      },
    });
    expect(JSON.stringify(diagnostics)).not.toContain("secret value with spaces");
    expect(JSON.stringify(diagnostics)).not.toContain("code");
  });
});

describe("simulator DingTalk authorization client", () => {
  it("provides a distinct non-owner identity for authorization integration tests", async () => {
    await expect(
      createSimulatorDingTalkClient().exchangeInternalAuthorizationCode("simulator-member-002"),
    ).resolves.toEqual({ dingtalkUserId: "simulator-user-002", displayName: "模拟非创建者" });
  });
});
