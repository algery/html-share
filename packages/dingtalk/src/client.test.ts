import { afterEach, describe, expect, it, vi } from "vitest";

import { createLiveDingTalkClient } from "./client.js";

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
    const identity = await client().exchangeExternalAuthorizationCode("authorization-code");

    expect(authorizationUrl.searchParams.get("client_id")).toBe("public-client-id");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/auth/callback",
    );
    expect(authorizationUrl.searchParams.get("state")).toBe("signed-state");
    expect(identity).toEqual({ dingtalkUserId: "ding-user-1", displayName: "成员" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      headers: { "x-acs-dingtalk-access-token": "provider-access-token" },
    });
  });

  it("maps provider rejection and malformed payloads to sanitized authorization errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("provider details", { status: 401 })),
    );

    await expect(client().exchangeInternalAuthorizationCode("rejected-code")).rejects.toMatchObject(
      {
        code: "AUTHORIZATION_DENIED",
        message: "AUTHORIZATION_DENIED",
      },
    );
  });
});
