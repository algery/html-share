import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { inspectContent, inspectFileName, scanRoot } from "./secret-hygiene.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("secret hygiene", () => {
  it("allows the exact isolated MinIO fixture only for its dedicated variable", () => {
    const value = "local-password-test-only";
    expect(inspectContent(`PHASE9_MINIO_ACCESS_KEY_SECRET=${value}`)).toEqual([]);
    expect(inspectContent(`API_KEY=${value}`)).toEqual(["non-placeholder-API_KEY"]);
    expect(inspectContent(`PHASE9_MINIO_ACCESS_KEY_SECRET=${value}-changed`)).toEqual([
      "non-placeholder-PHASE9_MINIO_ACCESS_KEY_SECRET",
    ]);
  });

  it("allows the two explicit database examples while rejecting other env files", () => {
    expect(inspectFileName("/fixture/.env.mysql.example")).toBe(false);
    expect(inspectFileName("/fixture/.env.example")).toBe(false);
    expect(inspectFileName("/fixture/.env.mysql.local")).toBe(true);
    expect(inspectFileName("/fixture/.env.other.example")).toBe(true);
    expect(inspectContent("MYSQL_PASSWORD=unreviewed-sensitive-value")).toHaveLength(1);
  });

  it("allows only the exact synthetic password key for its dedicated variable", () => {
    const example = Buffer.alloc(32, 1).toString("base64");
    expect(inspectContent(`PASSWORD_RESULT_ENCRYPTION_KEY=${example}`)).toEqual([]);
    expect(
      inspectContent(
        `PASSWORD_MANAGEMENT_ENCRYPTION_KEY=${Buffer.alloc(32, 2).toString("base64")}`,
      ),
    ).toEqual([]);
    expect(inspectContent(`API_KEY=${example}`)).toEqual(["non-placeholder-API_KEY"]);
    expect(
      inspectContent(`PASSWORD_RESULT_ENCRYPTION_KEY=${Buffer.alloc(32, 2).toString("base64")}`),
    ).toEqual(["non-placeholder-PASSWORD_RESULT_ENCRYPTION_KEY"]);
    expect(inspectContent(`PASSWORD_MANAGEMENT_ENCRYPTION_KEY=${example}`)).toEqual([
      "non-placeholder-PASSWORD_MANAGEMENT_ENCRYPTION_KEY",
    ]);
  });

  it("accepts explicit local examples and rejects broad local-looking values", () => {
    expect(inspectContent("POSTGRES_PASSWORD=html_share_local")).toEqual([]);
    expect(
      inspectContent(
        "AUTH_STATE_SECRET=local-development-state-signing-key-change-before-production\nDINGTALK_CLIENT_SECRET=\nDINGTALK_API_BASE_URL=https://api.dingtalk.com",
      ),
    ).toEqual([]);
    expect(inspectContent("API_KEY=live-local-customer-value")).toEqual([
      "non-placeholder-API_KEY",
    ]);
  });

  it("recognizes only bounded numeric password rate settings", () => {
    expect(inspectContent("PASSWORD_VERIFY_IP_RATE_LIMIT_PER_MINUTE=60")).toEqual([]);
    expect(inspectContent("PASSWORD_VERIFY_IP_RATE_LIMIT_PER_MINUTE=100001")).toHaveLength(1);
    expect(inspectContent("PASSWORD_VERIFY_UNKNOWN_RATE_LIMIT_PER_MINUTE=60")).toHaveLength(1);
  });

  it("detects long DingTalk Client Secret values without returning the value", () => {
    const findings = inspectContent(`Client Secret：${"x".repeat(40)}`);
    expect(findings).toEqual(["non-placeholder-DINGTALK_CLIENT_SECRET"]);
    expect(findings.join(" ")).not.toContain("x".repeat(40));
  });

  it("fails closed when a file cannot be read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "html-share-secret-test-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "config.txt"), "safe=true", "utf8");
    const root = pathToFileURL(`${directory}/`);

    await expect(
      scanRoot(root, async () => {
        throw new Error("synthetic read failure");
      }),
    ).resolves.toEqual([{ file: "config.txt", reason: "read-failed" }]);
  });
});
