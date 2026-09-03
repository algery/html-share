import { describe, expect, it } from "vitest";

import {
  completeDingTalkInAppLogin,
  readDingTalkBridge,
  requestAuthCode,
  type DingTalkBridge,
} from "./dingtalk-in-app";

describe("DingTalk in-app authorization", () => {
  it("obtains an in-app authorization code and submits it with a server state", async () => {
    const requests: { input: string; init: RequestInit }[] = [];
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
          return response({ state: "signed-state" });
        }
        return response(null, "http://app.localhost:3000/", true);
      },
      returnPath: "/",
    });

    expect(redirectUrl).toBe("http://app.localhost:3000/");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.init.body).toBe('{"code":"simulator-member","state":"signed-state"}');
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
});

function response(payload: unknown, location?: string, ok = true) {
  return {
    headers: { get: (name: string) => (name === "location" ? (location ?? null) : null) },
    json: async () => payload,
    ok,
  };
}
