import { afterEach, describe, expect, it, vi } from "vitest";

import { createFeishuClient } from "./feishu-client.js";

afterEach(() => vi.useRealTimers());

const callbackUrl = "https://app.example.test/auth/feishu/callback";
const tokenPayload = { code: 0, access_token: "private-user-token", token_type: "Bearer" };
const userData = { open_id: "ou-member", tenant_key: "tenant-allowed", name: "飞书成员" };
const json = (value: unknown) => new Response(JSON.stringify(value));
const client = (fetcher: typeof fetch) =>
  createFeishuClient({
    appId: "cli-example",
    appSecret: "private-app-secret",
    tenantKey: "tenant-allowed",
    fetcher,
  });

describe("Feishu OAuth client", () => {
  it("uses the official authorize endpoint and minimal contact scopes with S256 PKCE", () => {
    const url = new URL(
      client(vi.fn()).createAuthorizationUrl({
        callbackUrl,
        state: "signed-browser-state",
        codeChallenge: "pkce-challenge",
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "cli-example",
      redirect_uri: callbackUrl,
      response_type: "code",
      scope: "contact:user.phone:readonly contact:user.email:readonly",
      state: "signed-browser-state",
      code_challenge: "pkce-challenge",
      code_challenge_method: "S256",
    });
    expect(url.toString()).not.toContain("private-app-secret");
  });

  it("exchanges a code at v3 with the exact redirect and only reads authenticated user info", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(tokenPayload))
      .mockResolvedValueOnce(
        json({
          code: 0,
          data: {
            ...userData,
            mobile: "+86 138-0013-8000",
            email: " Member+Html@Example.Test ",
            enterprise_email: "another@example.test",
          },
        }),
      );
    await expect(
      client(fetcher).exchangeAuthorizationCode({
        code: "one-use-code",
        callbackUrl,
        codeVerifier: "pkce-verifier",
      }),
    ).resolves.toEqual({
      feishuAppId: "cli-example",
      feishuTenantKey: "tenant-allowed",
      feishuOpenId: "ou-member",
      displayName: "飞书成员",
      phone: "+8613800138000",
      email: "member+html@example.test",
    });
    const tokenCall = fetcher.mock.calls[0];
    expect(tokenCall?.[0]).toBe("https://accounts.feishu.cn/oauth/v3/token");
    expect(tokenCall?.[1]).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json; charset=utf-8" },
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(String(tokenCall?.[1]?.body))).toMatchObject({
      grant_type: "authorization_code",
      client_id: "cli-example",
      client_secret: "private-app-secret",
      code: "one-use-code",
      redirect_uri: callbackUrl,
      code_verifier: "pkce-verifier",
    });
    expect(fetcher.mock.calls[1]).toEqual([
      "https://open.feishu.cn/open-apis/authen/v1/user_info",
      {
        headers: { authorization: "Bearer private-user-token" },
        redirect: "error",
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps contact-free login available and never substitutes enterprise_email", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(tokenPayload))
      .mockResolvedValueOnce(
        json({
          code: 0,
          data: {
            ...userData,
            mobile: "+86138****8000",
            email: "",
            enterprise_email: "other@example.test",
          },
        }),
      );
    await expect(
      client(fetcher).exchangeAuthorizationCode({ code: "code", callbackUrl }),
    ).resolves.toEqual({
      feishuAppId: "cli-example",
      feishuTenantKey: "tenant-allowed",
      feishuOpenId: "ou-member",
      displayName: "飞书成员",
    });
    expect(
      new URL(
        client(vi.fn()).createAuthorizationUrl({ callbackUrl, state: "state" }),
      ).searchParams.has("code_challenge"),
    ).toBe(false);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).not.toHaveProperty(
      "code_verifier",
    );
  });

  it.each(["tenant-other", "TENANT-ALLOWED"])(
    "rejects a different tenant exactly: %s",
    async (tenantKey) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(json(tokenPayload))
        .mockResolvedValueOnce(
          json({
            code: 0,
            data: { ...userData, tenant_key: tenantKey },
          }),
        );
      await expect(
        client(fetcher).exchangeAuthorizationCode({ code: "code", callbackUrl }),
      ).rejects.toMatchObject({
        code: "AUTHORIZATION_DENIED",
        details: { stage: "identity_lookup", failureReason: "tenant_mismatch" },
      });
    },
  );

  it.each([
    { open_id: "" },
    { open_id: " ou-member" },
    { open_id: null },
    { open_id: 1 },
    { open_id: "ou-成员" },
    { open_id: "ou-\u0000member" },
    { open_id: "a".repeat(256) },
    { tenant_key: "" },
    { tenant_key: "tenant-allowed " },
    { name: "" },
  ])("rejects invalid user identity fields: %j", async (fields) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(tokenPayload))
      .mockResolvedValueOnce(json({ code: 0, data: { ...userData, ...fields } }));
    await expect(
      client(fetcher).exchangeAuthorizationCode({ code: "code", callbackUrl }),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { stage: "identity_lookup", failureReason: "invalid_response" },
    });
  });

  it.each([20008, 20021, 20022, 20023])("denies rejected or inactive users: %s", async (code) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(tokenPayload))
      .mockResolvedValueOnce(
        json({
          code,
          msg: "private-contact@example.test",
          data: userData,
        }),
      );
    const failure = await client(fetcher)
      .exchangeAuthorizationCode({ code: "private-code", callbackUrl })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "AUTHORIZATION_DENIED",
      details: { stage: "identity_lookup" },
    });
    expect(JSON.stringify(failure)).not.toMatch(
      /private-contact|private-code|private-user-token|private-app-secret/,
    );
  });
});
