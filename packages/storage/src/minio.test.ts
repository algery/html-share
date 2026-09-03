import { describe, expect, it } from "vitest";

import { assertDeleteCompleted } from "./minio.js";

describe("assertDeleteCompleted", () => {
  it("allows a complete S3 batch deletion", () => {
    expect(() => assertDeleteCompleted([])).not.toThrow();
  });

  it("turns an S3 partial delete response into a retryable failure", () => {
    expect(() =>
      assertDeleteCompleted([{ Code: "AccessDenied", Key: "temporary/failed.zip" }]),
    ).toThrow("OBJECT_DELETE_PARTIAL_FAILURE:temporary/failed.zip");
  });
});
