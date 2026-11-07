import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { preflight } from "../skills/html-share/scripts/preflight.mjs";
import {
  extractProjectId,
  publishDemo,
  uploadPreparedFiles,
} from "../skills/html-share/scripts/upload.mjs";
import { mcpHarness, publishInput } from "./phase6-mcp-harness.test-helper.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Phase 6 demo share Skill", () => {
  it("creates a stable per-file manifest with SHA-256, Content-MD5, and server-compatible MIME", async () => {
    const directory = await fixture({
      "assets/logo.txt": "logo",
      "index.html": '<!doctype html><link href="assets/logo.txt"><h1>ready</h1>',
    });
    const before = await tree(directory);
    const first = await preflight({ publishDir: directory, targetHtml: "index.html" });
    const second = await preflight({ publishDir: directory, targetHtml: "index.html" });

    expect(first).toMatchObject({ fileCount: 2, status: "ready" });
    expect(first.files).toEqual(second.files);
    expect(first.manifestDigest).toBe(second.manifestDigest);
    expect(first.files[1]).toMatchObject({
      content_md5: expect.stringMatching(/^[A-Za-z0-9+/]{22}==$/),
      mime_type: "text/html; charset=utf-8",
      relative_path: "index.html",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await tree(directory)).toEqual(before);
  });

  it("blocks sensitive files and directory-external symbolic links", async () => {
    const directory = await fixture({ ".env": "TOKEN=secret", "index.html": "<h1>blocked</h1>" });
    const outside = await fixture({ "private.txt": "not for upload" });
    await symlink(join(outside, "private.txt"), join(directory, "outside.txt"));
    const checked = await preflight({ publishDir: directory, targetHtml: "index.html" });
    expect(checked.status).toBe("blocked");
    expect(checked.blocks.map((item) => item.id)).toEqual(
      expect.arrayContaining(["PATH_ESCAPE", "SENSITIVE_FILE"]),
    );
  });

  it("blocks double-encoded gateway paths before upload", async () => {
    const directory = await fixture({
      "assets/a%2Fb.png": "not addressable",
      "index.html": "<h1>safe target</h1>",
    });

    const checked = await preflight({ publishDir: directory, targetHtml: "index.html" });

    expect(checked.blocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "PATH_ESCAPE" })]),
    );
  });

  it("detects replacement after preflight and never uploads the changed bytes", async () => {
    const directory = await fixture({ "index.html": "inside payload" });
    const outside = await fixture({ "outside.html": "outside payload must never upload" });
    let dataPlaneCalls = 0;
    await expect(
      publishDemo(
        publishInput(directory),
        mcpHarness({
          afterPrepare: async () => {
            await unlink(join(directory, "index.html"));
            await symlink(join(outside, "outside.html"), join(directory, "index.html"));
          },
          onUpload: async () => {
            dataPlaneCalls += 1;
          },
        }),
      ),
    ).rejects.toThrow("预检后文件发生变化");
    expect(dataPlaneCalls).toBe(0);
  });

  it("scans high-confidence keys in files larger than one MiB", async () => {
    const directory = await fixture({
      "index.html": Buffer.concat([
        Buffer.alloc(1024 * 1024 + 10, "x"),
        Buffer.from(
          "AKIA1234567890ABCDEF sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ),
      ]),
    });
    const checked = await preflight({ publishDir: directory, targetHtml: "index.html" });
    expect(checked.blocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "SECRET_CONTENT" })]),
    );
  });

  it("accepts exact file, total-size, and file-count limits but blocks values above them", async () => {
    const boundary = await fixture({ "index.html": Buffer.alloc(5 * 1024 * 1024) });
    for (let index = 1; index < 500; index += 1) {
      await writeFile(join(boundary, `file-${index}.txt`), "");
    }
    const allowed = await preflight({ publishDir: boundary, targetHtml: "index.html" });
    expect(allowed.blocks).toEqual([]);
    expect(allowed.fileCount).toBe(500);

    const totalBoundary = await fixture({
      "index.html": Buffer.alloc(5 * 1024 * 1024),
      "part-1.bin": Buffer.alloc(5 * 1024 * 1024),
      "part-2.bin": Buffer.alloc(5 * 1024 * 1024),
      "part-3.bin": Buffer.alloc(5 * 1024 * 1024),
    });
    expect(
      (await preflight({ publishDir: totalBoundary, targetHtml: "index.html" })).blocks,
    ).toEqual([]);
    await writeFile(join(totalBoundary, "one-byte.txt"), "x");
    expect(
      (await preflight({ publishDir: totalBoundary, targetHtml: "index.html" })).blocks,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: "TOTAL_SIZE_LIMIT" })]));

    const tooLarge = await fixture({ "index.html": Buffer.alloc(5 * 1024 * 1024 + 1) });
    expect((await preflight({ publishDir: tooLarge, targetHtml: "index.html" })).blocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "FILE_SIZE_LIMIT" })]),
    );
  });

  it("uploads original files directly with bounded concurrency and exact signed headers", async () => {
    const directory = await fixture(
      Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [
          index === 0 ? "index.html" : `${index}.txt`,
          `file-${index}`,
        ]),
      ),
    );
    const inspection = await preflight({ publishDir: directory, targetHtml: "index.html" });
    let active = 0;
    let maximum = 0;
    const bodies = [];
    const uploads = inspection.files.map((file) => ({
      relative_path: file.relative_path,
      upload_headers: {
        "content-length": String(file.size),
        "content-md5": file.content_md5,
        "content-type": file.mime_type,
      },
      upload_url: `https://storage.test/${file.relative_path}`,
    }));
    await expect(
      uploadPreparedFiles(
        { concurrency: 3, inspection, timeoutMs: 1_000, uploads },
        {
          request: async (_url, init) => {
            active += 1;
            maximum = Math.max(maximum, active);
            const chunks = [];
            for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
            await Promise.resolve();
            bodies.push(Buffer.concat(chunks).toString());
            active -= 1;
            return { ok: true };
          },
        },
      ),
    ).resolves.toBe(true);
    expect(maximum).toBeLessThanOrEqual(3);
    expect(bodies).toHaveLength(8);
  });

  it("publishes via direct file PUTs, polls terminal status, and returns the exact link", async () => {
    const directory = await fixture({ "index.html": "<h1>published</h1>" });
    const calls = [];
    let requestFiles;
    const result = await publishDemo(
      publishInput(directory),
      mcpHarness({
        calls,
        onPrepare: (args) => {
          requestFiles = args.files;
        },
      }),
    );
    expect(requestFiles).toEqual([
      expect.objectContaining({
        content_md5: expect.any(String),
        mime_type: "text/html; charset=utf-8",
        relative_path: "index.html",
        sha256: expect.any(String),
        size: 18,
      }),
    ]);
    expect(calls).toEqual([
      "check_connection",
      "prepare_demo_upload",
      "complete_demo_upload",
      "get_demo_upload_status",
    ]);
    expect(result).toEqual({
      accessMode: "organization",
      projectId: "abc12",
      shareUrl: "https://demo.example.test/abc12/index.html",
      uploadId: "d290f1ee-6c54-4b01-90e6-d701748f0851",
    });
  });

  it("encodes reserved target characters in the returned share URL", async () => {
    const directory = await fixture({ "index?.html": "<h1>encoded</h1>" });

    const result = await publishDemo(
      { ...publishInput(directory), targetHtml: "index?.html" },
      mcpHarness(),
    );

    expect(result.shareUrl).toBe("https://demo.example.test/abc12/index%3F.html");
  });

  it("bounds a hanging MCP request without creating an archive or temporary content copy", async () => {
    const directory = await fixture({ "index.html": "<h1>timeout</h1>" });
    const before = await tree(directory);
    await expect(
      publishDemo(
        { ...publishInput(directory), requestTimeoutMs: 10 },
        {
          request: async (_url, init) =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        },
      ),
    ).rejects.toThrow("请求超时");
    expect(await tree(directory)).toEqual(before);
  });

  it("accepts only exact project identifiers in replacement links", () => {
    expect(extractProjectId("abc12")).toBe("abc12");
    expect(extractProjectId("https://demo.example.test/abc12/nested/index.html")).toBe("abc12");
    expect(() => extractProjectId("https://demo.example.test/abcdef/index.html")).toThrow();
  });
});

async function fixture(files) {
  const directory = await mkdtemp(join(tmpdir(), "html-share-phase6-test-"));
  directories.push(directory);
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path);
    await (await import("node:fs/promises")).mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  return directory;
}

async function tree(directory) {
  const names = await readdir(directory, { recursive: true });
  return createHash("sha256").update(JSON.stringify(names.sort())).digest("hex");
}
