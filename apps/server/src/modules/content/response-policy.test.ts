import { describe, expect, it } from "vitest";

import { contentTypeForPath } from "@html-share/core";

describe("contentTypeForPath", () => {
  it("serves both HTML extensions recognized by archive validation as HTML", () => {
    expect(contentTypeForPath("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeForPath("legacy/demo.htm")).toBe("text/html; charset=utf-8");
  });

  it("falls back to binary only for unrecognized extensions", () => {
    expect(contentTypeForPath("asset.unknown")).toBe("application/octet-stream");
  });
});
