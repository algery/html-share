import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preflight } from "../skills/html-share/scripts/preflight.mjs";
import { publishDemo } from "../skills/html-share/scripts/upload.mjs";
import { mcpHarness, publishInput } from "./phase6-mcp-harness.test-helper.mjs";
import { passwordHarness } from "./password-skill.test-helper.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Phase 13 Skill risk gates at the publication entry point", () => {
  it.each(["sensitive", "escape"])(
    "never uploads %s files despite matching acknowledgement and force options",
    async (kind) => {
      const directory = await fixture();
      if (kind === "sensitive") await writeFile(join(directory, ".env"), "DUMMY_FIXTURE=1");
      else {
        const outside = await fixture();
        await symlink(join(outside, "index.html"), join(directory, "outside.html"));
      }
      const before = await snapshot(directory);
      const inspected = await preflight({ publishDir: directory, targetHtml: "index.html" });
      expect(inspected.blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: kind === "sensitive" ? "SENSITIVE_FILE" : "PATH_ESCAPE" }),
        ]),
      );
      for (const accessMode of [undefined, "password"]) {
        let requests = 0;
        await expect(
          publishDemo(
            {
              ...publishInput(directory),
              accessMode,
              riskAckDigest: inspected.riskAckDigest,
              force: true,
              skipPreflight: true,
            },
            {
              request: async () => {
                requests++;
                throw new Error("unexpected network request");
              },
            },
          ),
        ).rejects.toThrow("硬阻断");
        expect(requests).toBe(0);
        expect(await snapshot(directory)).toEqual(before);
      }
    },
  );

  it.each([undefined, "password"])(
    "requires exact risk acknowledgement before any network request (%s)",
    async (accessMode) => {
      const directory = await fixture();
      const before = await snapshot(directory);
      const inspected = await preflight({ publishDir: directory, targetHtml: "index.html" });
      expect(inspected.status).toBe("confirmation_required");
      expect(inspected.risks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "ROOT_ABSOLUTE_PATH",
            path: "index.html",
            message: expect.stringContaining("字符"),
          }),
        ]),
      );
      for (const riskAckDigest of [undefined, "wrong-digest"]) {
        let requests = 0;
        await expect(
          publishDemo(
            { ...publishInput(directory), accessMode, riskAckDigest },
            {
              request: async () => {
                requests++;
                throw new Error("unexpected network request");
              },
            },
          ),
        ).rejects.toThrow("风险确认摘要不匹配");
        expect(requests).toBe(0);
        expect(await snapshot(directory)).toEqual(before);
      }
      const calls = [];
      const uploads = [];
      let prepared;
      const harness =
        accessMode === "password"
          ? passwordHarness()
          : mcpHarness({
              calls,
              onPrepare: (args) => {
                prepared = args;
              },
            });
      const result = await publishDemo(
        {
          ...publishInput(directory),
          accessMode,
          riskAckDigest: inspected.riskAckDigest,
        },
        {
          ...harness,
          request: async (url, init) => {
            if (init.method === "PUT") uploads.push(String(url));
            return harness.request(url, init);
          },
        },
      );
      const actualCalls = accessMode === "password" ? harness.calls : calls;
      prepared = accessMode === "password" ? harness.prepares[0] : prepared;
      expect(actualCalls).toContain("prepare_demo_upload");
      expect(actualCalls.at(-1)).toBe("get_demo_upload_status");
      expect(prepared.risk_ack_digest).toBe(inspected.riskAckDigest);
      expect(prepared.files.map((file) => file.relative_path)).toEqual([
        "assets/app.js",
        "index.html",
      ]);
      expect(uploads).toHaveLength(2);
      expect(result.accessMode).toBe(accessMode ?? "organization");
      expect(await snapshot(directory)).toEqual(before);
    },
  );

  it.each(["content", "add", "rename", "remove"])(
    "invalidates previous confirmation when the directory changes: %s",
    async (change) => {
      const directory = await fixture();
      const previous = await preflight({ publishDir: directory, targetHtml: "index.html" });
      if (change === "content") await writeFile(join(directory, "assets/app.js"), "/* two */");
      if (change === "add") await writeFile(join(directory, "new.txt"), "new");
      if (change === "rename")
        await rename(join(directory, "assets/app.js"), join(directory, "assets/new.js"));
      if (change === "remove") await rm(join(directory, "assets/app.js"));
      const before = await snapshot(directory);
      const current = await preflight({ publishDir: directory, targetHtml: "index.html" });
      expect(current.riskAckDigest).not.toBe(previous.riskAckDigest);
      let requests = 0;
      await expect(
        publishDemo(
          {
            ...publishInput(directory),
            accessMode: "password",
            riskAckDigest: previous.riskAckDigest,
          },
          {
            request: async () => {
              requests++;
              throw new Error("unexpected network request");
            },
          },
        ),
      ).rejects.toThrow("风险确认摘要不匹配");
      expect(requests).toBe(0);
      expect(await snapshot(directory)).toEqual(before);
    },
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "html-share-risk-unit-"));
  directories.push(directory);
  await mkdir(join(directory, "assets"));
  await writeFile(
    join(directory, "index.html"),
    '<!doctype html><script src="/assets/app.js"></script>',
  );
  await writeFile(join(directory, "assets/app.js"), "/* one */");
  return directory;
}

async function snapshot(directory) {
  const result = [];
  async function visit(path = "") {
    const absolute = join(directory, path);
    const details = await lstat(absolute);
    result.push({
      path,
      mode: details.mode,
      mtime: details.mtimeMs,
      ctime: details.ctimeMs,
      content: details.isSymbolicLink()
        ? await readlink(absolute)
        : details.isFile()
          ? createHash("sha256")
              .update(await readFile(absolute))
              .digest("hex")
          : null,
    });
    if (details.isDirectory())
      for (const name of (await readdir(absolute)).sort()) await visit(join(path, name));
  }
  await visit();
  return result;
}
