import { describe, expect, it } from "vitest";

import { resolveDemoContentPath } from "./path-resolver.js";

describe("Demo content path resolver", () => {
  it("decodes a valid percent-encoded filename once", () => {
    expect(resolveDemoContentPath("/abc12/100%25/a.html")).toEqual({
      projectKey: "abc12",
      relativePath: "100%/a.html",
    });
  });

  it("rejects encoded separators and double-encoded traversal", () => {
    for (const path of [
      "/abc12/%2e%2e/a.html",
      "/abc12/%252e%252e/a.html",
      "/abc12/a%2fb.html",
      "/abc12/a%255cb.html",
      "/abc12/%00a.html",
    ]) {
      expect(resolveDemoContentPath(path)).toBeNull();
    }
  });
});
