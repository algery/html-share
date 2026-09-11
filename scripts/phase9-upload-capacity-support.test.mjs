import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { cleanupTemporary, uploadDirectFiles } from "./phase9-upload-capacity-support.mjs";

describe("Phase 9 upload capacity support", () => {
  it("keeps the generic k6 capacity flow on direct per-file uploads", async () => {
    const source = await readFile(new URL("../tests/load/upload.js", import.meta.url), "utf8");
    expect(source).toContain("prepared.uploads");
    expect(source).toContain("UPLOAD_SOURCE_MAP_PATH");
    expect(source).not.toContain("ARCHIVE_PATH");
    expect(source).not.toMatch(/archive uploaded|\.zip\b/i);
  });

  it("redacts a failed pre-signed PUT command", async () => {
    const sensitiveUrl = "https://object.invalid/upload?X-Amz-Signature=redacted-test-value";
    let failure;
    try {
      await uploadDirectFiles({
        execute: async () => {
          throw new Error(sensitiveUrl);
        },
        files: [{ relative_path: "index.html", sourcePath: "/tmp/fixture/index.html" }],
        prepared: {
          uploads: [
            {
              relative_path: "index.html",
              upload_headers: { "x-amz-security-token": "redacted-test-value" },
              upload_url: sensitiveUrl,
            },
          ],
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe("direct file PUT failed or timed out");
    expect(failure.message).not.toContain(sensitiveUrl);
  });

  it("removes the local fixture even when temporary Token revocation fails", async () => {
    const calls = [];
    const reports = [];
    const errors = await cleanupTemporary({
      fixture: { directory: "/tmp/phase9-fixture" },
      removeDirectory: async (directory) => calls.push(`remove:${directory}`),
      report: (result) => reports.push(result),
      revokeToken: async () => {
        calls.push("revoke");
        throw new Error("simulated revoke failure");
      },
      sessionCookie: "test-session-cookie",
      temporaryToken: { id: "test-token" },
    });

    expect(calls).toEqual(["revoke", "remove:/tmp/phase9-fixture"]);
    expect(errors).toEqual(["temporary MCP token revocation failed"]);
    expect(reports).toEqual([{ temporaryFixtureRemoved: true }]);
  });
});
