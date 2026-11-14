import { afterEach, describe, expect, it, vi } from "vitest";

import { createFeishuClient } from "./feishu-client.js";

afterEach(() => vi.useRealTimers());

const token = { code: 0, access_token: "private-token", token_type: "Bearer" };
const json = (value: unknown) => new Response(JSON.stringify(value));
const exchange = (fetcher: typeof fetch) =>
  createFeishuClient({
    appId: "cli-example",
    appSecret: "private-secret",
    tenantKey: "tenant-allowed",
    fetcher,
  }).exchangeAuthorizationCode({
    code: "private-code",
    callbackUrl: "https://app.example.test/auth/feishu/callback",
  });

describe("Feishu upstream boundaries", () => {
  it.each([
    { code: 0, data: { access_token: "legacy-token" } },
    { code: 0, access_token: "", token_type: "Bearer" },
    { code: 0, access_token: "token", token_type: "other" },
    { ...token, code: "0" },
    { access_token: "token" },
    [],
    null,
  ])("rejects malformed token envelopes: %j", async (payload) => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(payload));
    await expect(exchange(fetcher)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { stage: "token_exchange", failureReason: "invalid_response" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([null, [], "untrusted", undefined])(
    "rejects malformed identity data: %j",
    async (data) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(json(token))
        .mockResolvedValueOnce(json({ code: 0, data }));
      await expect(exchange(fetcher)).rejects.toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
        details: { stage: "identity_lookup", failureReason: "invalid_response" },
      });
    },
  );

  it.each([
    [400, "AUTHORIZATION_DENIED"],
    [401, "AUTHORIZATION_DENIED"],
    [403, "AUTHORIZATION_DENIED"],
    [429, "PROVIDER_UNAVAILABLE"],
    [500, "PROVIDER_UNAVAILABLE"],
    [503, "PROVIDER_UNAVAILABLE"],
  ])("handles HTTP %s without returning provider response data", async (status, code) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("private-token private-secret", { status: Number(status) }),
      );
    const failure = await exchange(fetcher).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code,
      details: { failureReason: "provider_rejected", httpStatus: status },
    });
    expect(JSON.stringify(failure)).not.toMatch(/private-token|private-secret|private-code/);
  });

  it.each([20003, 20004, 20065, 20066])(
    "rejects OAuth failure code %s even on HTTP 200",
    async (code) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          json({ ...token, code, error_description: "sensitive upstream body" }),
        );
      await expect(exchange(fetcher)).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each([20050, 20072])("classifies provider availability code %s", async (code) => {
    await expect(exchange(vi.fn().mockResolvedValueOnce(json({ code })))).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it.each(["not-json", JSON.stringify({ ...token, extra: "x".repeat(65_536) })])(
    "bounds and validates JSON bodies",
    async (body) => {
      await expect(
        exchange(vi.fn().mockResolvedValueOnce(new Response(body))),
      ).rejects.toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
        details: { failureReason: "invalid_response" },
      });
    },
  );

  it("rejects oversized declared bodies without reading them", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(body, { headers: { "content-length": "65537" } }));
    await expect(exchange(fetcher)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects redirects and does not expose transport exception messages", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("private-user-token in redirect"));
    const failure = await exchange(fetcher).catch((error: unknown) => error);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    expect(failure).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { failureReason: "network_error" },
    });
    expect(JSON.stringify(failure)).not.toContain("private-user-token");
  });

  it.each(["token_exchange", "identity_lookup"])(
    "times out stalled headers during %s",
    async (stage) => {
      vi.useFakeTimers();
      const fetcher = vi.fn();
      if (stage === "identity_lookup") fetcher.mockResolvedValueOnce(json(token));
      fetcher.mockImplementationOnce(() => new Promise<Response>(() => undefined));
      const pending = expect(exchange(fetcher)).rejects.toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
        details: { stage, failureReason: "network_error" },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      expect(fetcher.mock.calls.at(-1)?.[1]?.signal.aborted).toBe(true);
    },
  );

  it("includes streaming time in its deadline and cancels a stalled body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(token))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel })));
    const pending = expect(exchange(fetcher)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { stage: "identity_lookup", failureReason: "network_error" },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
