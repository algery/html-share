import { describe, expect, it } from "vitest";

import { EnvironmentValidationError, readFeishuEnv } from "./index.js";

describe("Feishu environment", () => {
  const enabled = {
    FEISHU_ENABLED: "true",
    FEISHU_APP_ID: "cli-example",
    FEISHU_APP_SECRET: "private-test-value",
    FEISHU_TENANT_KEY: "tenant-example",
  };

  it("defaults to disabled and omits ignored credentials", () => {
    expect(readFeishuEnv({})).toEqual({ FEISHU_ENABLED: false });
    expect(readFeishuEnv({ ...enabled, FEISHU_ENABLED: "false" })).toEqual({
      FEISHU_ENABLED: false,
    });
  });

  it("reads and trims all required configuration when enabled", () => {
    expect(readFeishuEnv({ ...enabled, FEISHU_APP_ID: " cli-example " })).toEqual({
      ...enabled,
      FEISHU_ENABLED: true,
    });
  });

  it.each(["", "1", "yes", "TRUE", " true "])("rejects an ambiguous switch: %s", (value) => {
    expect(() => readFeishuEnv({ ...enabled, FEISHU_ENABLED: value })).toThrow(/FEISHU_ENABLED/);
  });

  it.each(["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_TENANT_KEY"])(
    "rejects missing or blank %s without disclosing configured values",
    (key) => {
      for (const value of [undefined, "", "  "]) {
        let failure: unknown;
        try {
          readFeishuEnv({ ...enabled, [key]: value });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(EnvironmentValidationError);
        expect(failure).toMatchObject({ variables: [key] });
        expect(String(failure)).not.toContain(enabled.FEISHU_APP_SECRET);
        expect(String(failure)).not.toContain(enabled.FEISHU_TENANT_KEY);
      }
    },
  );
});
