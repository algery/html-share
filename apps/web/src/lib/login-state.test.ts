import { describe, expect, it } from "vitest";

import { resolveLoginState } from "./login-state";

describe("login state copy", () => {
  it("provides the required authorization states without exposing credentials", () => {
    expect(resolveLoginState(undefined).title).toBe("使用钉钉登录 Demo Share");
    expect(resolveLoginState("verifying").title).toBe("正在验证组织身份");
    expect(resolveLoginState("success").tone).toBe("success");
    expect(resolveLoginState("error").tone).toBe("error");
    expect(resolveLoginState("denied").description).toContain("不会返回 Demo 内容");
  });
});
