import { describe, expect, it } from "vitest";

import {
  completeDingTalkInAppLogin,
  readDingTalkBridge,
  requestAuthCode,
  type DingTalkBridge,
  type DingTalkInAppDiagnostic,
} from "./dingtalk-in-app";

describe("DingTalk in-app authorization", () => {
  it("obtains an in-app authorization code and submits it with a server state", async () => {
    const requests: { input: string; init: RequestInit }[] = [];
    const diagnostics: DingTalkInAppDiagnostic[] = [];
    const bridge: DingTalkBridge = {
      requestAuthCode({ clientId, corpId, success }) {
        expect(clientId).toBe("public-client-id");
        expect(corpId).toBe("corp-id");
        success({ code: "simulator-member" });
      },
    };

    const redirectUrl = await completeDingTalkInAppLogin({
      apiUrl: "http://app.localhost:3001",
      bridge,
      clientId: "public-client-id",
      corpId: "corp-id",
      fetcher: async (input, init) => {
        requests.push({ input, init });
        if (input.endsWith("/start")) {
          return response({ state: "signed-state" }, 200, "start-trace");
        }
        return response({ redirectUrl: "http://app.localhost:3000/" }, 200, "complete-trace");
      },
      reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      returnPath: "/",
    });

    expect(redirectUrl).toBe("http://app.localhost:3000/");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.init.body).toBe('{"code":"simulator-member","state":"signed-state"}');
    expect(diagnostics).toEqual([
      { outcome: "started", stage: "start_request" },
      { outcome: "succeeded", stage: "start_request", statusCode: 200, traceId: "start-trace" },
      { outcome: "started", stage: "auth_code_request" },
      { outcome: "succeeded", stage: "auth_code_request" },
      { outcome: "started", stage: "complete_request" },
      {
        outcome: "succeeded",
        stage: "complete_request",
        statusCode: 200,
        traceId: "complete-trace",
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("simulator-member");
    expect(JSON.stringify(diagnostics)).not.toContain("signed-state");
  });

  it("rejects unavailable, denied, and malformed in-app bridge responses", async () => {
    expect(readDingTalkBridge({})).toBeNull();
    await expect(
      requestAuthCode(
        { requestAuthCode: ({ fail }) => fail(new Error("denied")) },
        "public-client-id",
        "corp-id",
      ),
    ).rejects.toThrow("IN_APP_AUTH_CODE_REJECTED");
    await expect(
      requestAuthCode(
        { requestAuthCode: ({ success }) => success({}) },
        "public-client-id",
        "corp-id",
      ),
    ).rejects.toThrow("IN_APP_AUTH_CODE_MISSING");
    await expect(
      requestAuthCode({ requestAuthCode: () => undefined }, "public-client-id"),
    ).rejects.toThrow("IN_APP_AUTH_NOT_CONFIGURED");
  });

  it("does not let browser diagnostic failures break login", async () => {
    const bridge: DingTalkBridge = {
      requestAuthCode({ success }) {
        success({ code: "one-time-code" });
      },
    };

    await expect(
      completeDingTalkInAppLogin({
        apiUrl: "http://app.localhost:3001",
        bridge,
        clientId: "public-client-id",
        corpId: "corp-id",
        fetcher: async (input) =>
          input.endsWith("/start")
            ? response({ state: "signed-state" })
            : response({ redirectUrl: "http://app.localhost:3000/" }),
        reportDiagnostic: () => {
          throw new Error("console unavailable");
        },
        returnPath: "/",
      }),
    ).resolves.toBe("http://app.localhost:3000/");
  });
});

function response(payload: unknown, status = 200, traceId?: string) {
  return {
    headers: { get: (name: string) => (name === "x-trace-id" ? (traceId ?? null) : null) },
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  };
}
