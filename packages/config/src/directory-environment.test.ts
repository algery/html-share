import { describe, expect, it } from "vitest";
import { readDingTalkEnv } from "./environment.js";

describe("directory configuration", () => {
  const simulator = { DINGTALK_AUTH_MODE: "simulator" };
  it("defaults the live opt-in to false without changing simulator login", () => {
    expect(readDingTalkEnv(simulator)).toMatchObject({
      DINGTALK_DIRECTORY_ENABLED: false,
      DINGTALK_CONTACT_API_BASE_URL: "https://oapi.dingtalk.com",
    });
    expect(
      readDingTalkEnv({ ...simulator, DINGTALK_DIRECTORY_ENABLED: "true" })
        .DINGTALK_DIRECTORY_ENABLED,
    ).toBe(true);
  });
  it("rejects ambiguous switches and unsafe endpoint schemes", () => {
    for (const value of ["1", "yes", "", "TRUE"]) {
      expect(() => readDingTalkEnv({ ...simulator, DINGTALK_DIRECTORY_ENABLED: value })).toThrow(
        /DINGTALK_DIRECTORY_ENABLED/,
      );
    }
    expect(() =>
      readDingTalkEnv({ ...simulator, DINGTALK_CONTACT_API_BASE_URL: "file:///tmp/" }),
    ).toThrow(/DINGTALK_CONTACT_API_BASE_URL/);
  });
});
