import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { parseArguments } from "../skills/html-share/scripts/common.mjs";
import { getPublishedDemoResult, publishDemo } from "../skills/html-share/scripts/upload.mjs";
import {
  clientRequestId,
  fixture,
  passwordHarness,
  uploadId,
} from "./password-skill.test-helper.mjs";

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
async function setup(target) {
  const item = await fixture(target);
  cleanups.push(item.cleanup);
  return item;
}

describe("password publishing Skill", () => {
  it("parses explicit mode and a boolean regenerate flag without consuming the next option", () => {
    expect(
      parseArguments([
        "--access-mode",
        "password",
        "--regenerate-password",
        "--project-id",
        "abc12",
      ]),
    ).toEqual({ access_mode: "password", regenerate_password: true, project_id: "abc12" });
    expect(() => parseArguments(["--access-mode"])).toThrow("缺少值");
    expect(() => parseArguments(["--regenerate-password", "false"])).toThrow();
    expect(() =>
      parseArguments(["--access-mode", "password", "--access-mode", "organization"]),
    ).toThrow();
  });

  it("checks modern capability before explicit password preparation and returns only the generated password", async () => {
    const { input, directory } = await setup();
    const harness = passwordHarness();
    const result = await publishDemo({ ...input, accessMode: "password" }, harness);
    expect(harness.calls.slice(0, 3)).toEqual([
      "check_connection",
      "tools/list",
      "prepare_demo_upload",
    ]);
    expect(harness.prepares[0]).toMatchObject({
      access_mode: "password",
      client_request_id: clientRequestId,
    });
    expect(result).toEqual({
      projectId: "abc12",
      uploadId,
      shareUrl: "https://demo.example.test/abc12/index.html",
      accessMode: "password",
      passwordStatus: "generated",
      accessPassword: "Abcd2345",
    });
    expect(await readdir(directory)).toEqual(["index.html"]);
    expect(JSON.stringify(harness.prepares)).not.toContain("Abcd2345");
  });

  it("keeps omitted options compatible with the old organization service", async () => {
    const { input } = await setup();
    const harness = passwordHarness({
      oldSchema: true,
      result: {
        access_mode: undefined,
        access_password: undefined,
        password_status: undefined,
        target_url: undefined,
      },
    });
    expect(await publishDemo(input, harness)).toMatchObject({ accessMode: "organization" });
    expect(harness.calls).not.toContain("tools/list");
    expect(harness.prepares[0]).not.toHaveProperty("access_mode");
    expect(harness.prepares[0]).not.toHaveProperty("regenerate_password");
  });

  it.each([
    {
      options: {},
      result: { password_status: "retained", access_password: undefined },
      expected: { accessMode: "password", passwordMessage: "沿用原密码" },
    },
    {
      options: { accessMode: "password", regeneratePassword: true },
      result: {},
      expected: { accessPassword: "Abcd2345", passwordStatus: "generated" },
    },
    {
      options: { accessMode: "organization" },
      result: {
        access_mode: "organization",
        access_password: undefined,
        password_status: undefined,
      },
      expected: { accessMode: "organization" },
    },
  ])("preserves replacement semantics: $options", async ({ options, result, expected }) => {
    const { input } = await setup();
    const harness = passwordHarness({ result });
    const output = await publishDemo(
      { ...input, action: "replace", projectId: "abc12", ...options },
      harness,
    );
    expect(output).toMatchObject(expected);
    expect(harness.prepares[0].access_mode).toBe(options.accessMode);
    expect(harness.prepares[0].regenerate_password).toBe(options.regeneratePassword);
    if (!expected.accessPassword) expect(output).not.toHaveProperty("accessPassword");
  });

  it.each([
    { action: "create", regeneratePassword: true },
    { action: "replace", accessMode: "organization", regeneratePassword: true },
    { accessMode: "public" },
    { regeneratePassword: "true" },
  ])("rejects invalid explicit options before MCP: %j", async (options) => {
    const { input } = await setup();
    const harness = passwordHarness();
    await expect(
      publishDemo({ ...input, projectId: "abc12", ...options }, harness),
    ).rejects.toThrow();
    expect(harness.calls).toEqual([]);
  });

  it.each([
    { accessMode: "password" },
    { accessMode: "organization" },
    { regeneratePassword: true },
  ])("rejects old schemas before prepare without silently stripping %j", async (options) => {
    const { input } = await setup();
    const harness = passwordHarness({ oldSchema: true });
    await expect(
      publishDemo({ ...input, action: "replace", projectId: "abc12", ...options }, harness),
    ).rejects.toThrow("升级");
    expect(harness.prepares).toEqual([]);
  });

  it.each(["retryPrepare", "retryPut"])(
    "keeps all idempotency options identical during %s",
    async (kind) => {
      const { input } = await setup();
      const harness = passwordHarness({ [kind]: true });
      await publishDemo(
        {
          ...input,
          action: "replace",
          projectId: "abc12",
          accessMode: "password",
          regeneratePassword: true,
        },
        harness,
      );
      expect(harness.prepares).toHaveLength(2);
      expect(harness.prepares[0]).toEqual(harness.prepares[1]);
    },
  );

  it.each([
    { access_mode: undefined },
    { access_password: undefined },
    { password_status: undefined },
    { project_id: "other" },
    { upload_id: "bad" },
    { target_url: "https://evil.test/abc12/index.html" },
    { target_url: "https://demo.example.test/abc12/index.html?password=Abcd2345" },
    { target_url: "https://demo.example.test/abc12/wrong.html" },
  ])("refuses missing or inconsistent terminal data: %j", async (result) => {
    const { input } = await setup();
    await expect(
      publishDemo({ ...input, accessMode: "password" }, passwordHarness({ result })),
    ).rejects.toThrow();
  });

  it("returns the encoded exact target for Chinese, spaces and reserved filename characters", async () => {
    const { input } = await setup("目录/test ?.html");
    const target = "https://demo.example.test/abc12/%E7%9B%AE%E5%BD%95/test%20%3F.html";
    const result = await publishDemo(
      { ...input, accessMode: "password" },
      passwordHarness({ result: { target_url: target } }),
    );
    expect(result.shareUrl).toBe(target);
  });

  it.each(["failed", "expired", "processing"])("does not report success for %s", async (status) => {
    const { input } = await setup();
    const run = publishDemo(
      { ...input, accessMode: "password" },
      passwordHarness({ result: { status } }),
    );
    if (status === "processing")
      await expect(run).rejects.toThrow(
        `upload_id=${uploadId} client_request_id=${clientRequestId}`,
      );
    else await expect(run).rejects.toThrow(status === "expired" ? "过期" : "发布失败");
  });

  it("retrieves an existing task without re-upload or reset and explains unavailable passwords", async () => {
    const { input } = await setup();
    const harness = passwordHarness({
      result: { password_status: "unavailable", access_password: undefined },
    });
    const result = await getPublishedDemoResult(
      { ...input, action: undefined, projectId: "abc12", uploadId },
      harness,
    );
    expect(harness.calls).toEqual(["get_demo_upload_status"]);
    expect(result).toMatchObject({
      passwordStatus: "unavailable",
      passwordMessage: expect.stringContaining("24小时"),
    });
    expect(result).not.toHaveProperty("accessPassword");
  });

  it("never echoes raw upstream tool errors containing passwords or tokens", async () => {
    const { input } = await setup();
    try {
      await publishDemo(
        { ...input, accessMode: "password" },
        passwordHarness({ errorTool: "prepare_demo_upload" }),
      );
      throw new Error("Expected failure");
    } catch (error) {
      expect(error.message).toContain("MCP 请求失败");
      expect(error.message).not.toContain("Abcd2345");
      expect(error.message).not.toContain("token_never_logged");
    }
  });

  it("shows a safe immediate unavailable explanation for an expired task RPC", async () => {
    const { input } = await setup();
    const harness = passwordHarness({
      errorTool: "get_demo_upload_status",
      errorValue: { error: "upload_expired", message: "secret Abcd2345" },
    });
    await expect(
      getPublishedDemoResult({ ...input, projectId: "abc12", uploadId }, harness),
    ).rejects.toThrow("不能取回");
    expect(harness.calls).toEqual(["get_demo_upload_status"]);
  });

  it("refuses unsolicited password activation on an ordinary new publication", async () => {
    const { input } = await setup();
    await expect(publishDemo(input, passwordHarness())).rejects.toThrow("未明确要求");
  });

  it("keeps task recovery identifiers when the completion response is lost", async () => {
    const { input } = await setup();
    await expect(
      publishDemo(
        { ...input, accessMode: "password", requestTimeoutMs: 10 },
        passwordHarness({ timeoutTool: "complete_demo_upload" }),
      ),
    ).rejects.toThrow(`upload_id=${uploadId} client_request_id=${clientRequestId}`);
  });

  it("retains the stable client request ID when preparation loses its response", async () => {
    const { input } = await setup();
    const harness = passwordHarness({ timeoutTool: "prepare_demo_upload" });
    await expect(
      publishDemo({ ...input, accessMode: "password", requestTimeoutMs: 10 }, harness),
    ).rejects.toThrow(`client_request_id=${clientRequestId}`);
    expect(harness.calls).not.toContain("complete_demo_upload");
  });
});
