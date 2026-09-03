import { describe, expect, it } from "vitest";

import { assertOssDeleteCompleted } from "./aliyun-oss.js";

describe("assertOssDeleteCompleted", () => {
  it("accepts an OSS response containing every requested deletion", () => {
    expect(() => assertOssDeleteCompleted(["a", "b"], [{}, {}])).not.toThrow();
  });

  it("fails when a quiet=false OSS response omits a failed object", () => {
    expect(() => assertOssDeleteCompleted(["a", "b"], [{}])).toThrow(
      "OBJECT_DELETE_PARTIAL_FAILURE:1",
    );
  });
});
