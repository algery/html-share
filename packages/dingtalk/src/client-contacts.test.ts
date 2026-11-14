import { afterEach, describe, expect, it, vi } from "vitest";

import { createLiveDingTalkClient, type DingTalkAuthorizationDiagnostic } from "./client.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const client = () =>
  createLiveDingTalkClient({
    apiBaseUrl: "https://api.dingtalk.com",
    clientId: "client-id",
    clientSecret: "private-secret",
    externalAuthorizeUrl: "https://login.dingtalk.com/oauth2/auth",
  });
const json = (value: unknown) => new Response(JSON.stringify(value));
const token = { accessToken: "private-token" };

describe("DingTalk identity contacts", () => {
  it("reads only the authenticated mobile/email fields and preserves international stateCode", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(token))
      .mockResolvedValueOnce(
        json({
          openId: "existing-id",
          nick: "成员",
          mobile: "202-555-0123",
          stateCode: "1",
          email: " Member+Demo@Example.Test ",
          loginEmail: "ignored@example.test",
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(client().exchangeExternalAuthorizationCode("private-code")).resolves.toEqual({
      dingtalkUserId: "existing-id",
      displayName: "成员",
      phone: "+12025550123",
      email: "member+demo@example.test",
    });
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
    }
  });

  it.each([
    ["13800138000", undefined, "+8613800138000"],
    ["13800138000", "86", "+8613800138000"],
    ["+1 (202) 555-0123", "1", "+12025550123"],
    ["138****8000", "86", undefined],
    ["2025550123", undefined, undefined],
  ])("normalizes server mobile %s with stateCode %s", async (mobile, stateCode, phone) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json(token))
        .mockResolvedValueOnce(
          json({
            openId: "existing-id",
            nick: "成员",
            mobile,
            stateCode,
          }),
        ),
    );
    await expect(client().exchangeInternalAuthorizationCode("code")).resolves.toEqual({
      dingtalkUserId: "existing-id",
      displayName: "成员",
      ...(phone === undefined ? {} : { phone }),
    });
  });

  it("ignores malformed contacts and does not fall back to loginEmail", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json(token))
        .mockResolvedValueOnce(
          json({
            openId: "existing-id",
            nick: "成员",
            mobile: 13800138000,
            email: "m***@example.test",
            loginEmail: "someone@example.test",
          }),
        ),
    );
    await expect(client().exchangeInternalAuthorizationCode("code")).resolves.toEqual({
      dingtalkUserId: "existing-id",
      displayName: "成员",
    });
  });
});

describe("DingTalk upstream limits", () => {
  it.each(["not-json", JSON.stringify({ ...token, extra: "x".repeat(65_536) })])(
    "rejects invalid or oversized JSON",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(body)));
      await expect(client().exchangeInternalAuthorizationCode("code")).rejects.toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
        details: { failureReason: "invalid_response" },
      });
    },
  );

  it.each([429, 500, 503])("classifies HTTP %s as unavailable", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("private response", { status })),
    );
    await expect(client().exchangeInternalAuthorizationCode("code")).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { httpStatus: status, failureReason: "provider_rejected" },
    });
  });

  it("times out stalled headers and returns only safe diagnostics", async () => {
    vi.useFakeTimers();
    const diagnostics: DingTalkAuthorizationDiagnostic[] = [];
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetcher);
    const pending = expect(
      client().exchangeInternalAuthorizationCode("private-code", (value) =>
        diagnostics.push(value),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(fetcher.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toMatch(/private-code|private-token|private-secret/);
  });

  it("keeps the timeout active while reading the user info body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(token))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel })));
    vi.stubGlobal("fetch", fetcher);
    const pending = expect(
      client().exchangeInternalAuthorizationCode("code"),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { stage: "identity_lookup", failureReason: "network_error" },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
