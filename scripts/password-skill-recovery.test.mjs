import { afterEach, describe, expect, it } from "vitest";
import { getPublishedDemoResult, publishDemo } from "../skills/html-share/scripts/upload.mjs";
import { fixture, passwordHarness, uploadId } from "./password-skill.test-helper.mjs";

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("recovering newly allocated publication identities from safe errors", () => {
  it.each([
    { timeoutTool: "complete_demo_upload" },
    { result: { status: "processing" } },
    { result: { status: "failed" } },
    { failPut: true },
  ])("provides project, upload and generated client IDs after %j", async (options) => {
    const item = await fixture();
    cleanups.push(item.cleanup);
    const input = {
      ...item.input,
      clientRequestId: undefined,
      accessMode: "password",
      requestTimeoutMs: 10,
    };
    const harness = passwordHarness(options);
    const message = await publishDemo(input, harness).then(
      () => {
        throw new Error("Expected the publication to remain unsuccessful");
      },
      (error) => error.message,
    );
    const projectId = /project_id=([a-z0-9]{5})(?:\s|$)/.exec(message)?.[1];
    const recoveredUploadId = /upload_id=([a-f0-9-]{36})(?:\s|$)/i.exec(message)?.[1];
    const clientRequestId = /client_request_id=([a-f0-9-]{36})(?:\s|$)/i.exec(message)?.[1];
    expect(projectId).toBe("abc12");
    expect(recoveredUploadId).toBe(uploadId);
    expect(clientRequestId).toBe(harness.prepares[0].client_request_id);
    expect(clientRequestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(message).not.toContain("Abcd2345");
    expect(message).not.toContain(input.token);
    if (options.failPut) {
      expect(harness.prepares.every((args) => args.client_request_id === clientRequestId)).toBe(
        true,
      );
      expect(harness.calls).not.toContain("complete_demo_upload");
    }
    // Source path and trusted endpoints remain in the original user input; every
    // server-assigned identity needed by the read-only query comes from the error.
    const remainsFailed = options.failPut || options.result?.status === "failed";
    const queryHarness = passwordHarness(remainsFailed ? { result: { status: "failed" } } : {});
    const query = getPublishedDemoResult(
      { ...input, projectId, uploadId: recoveredUploadId, clientRequestId },
      queryHarness,
    );
    if (remainsFailed) await expect(query).rejects.toThrow("发布失败");
    else expect(await query).toMatchObject({ projectId, uploadId: recoveredUploadId });
    expect(queryHarness.calls).toEqual(["get_demo_upload_status"]);
  });
});
