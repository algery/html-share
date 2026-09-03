import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupArchive, packageDemo } from "../skills/html-share/scripts/package.mjs";
import { preflight } from "../skills/html-share/scripts/preflight.mjs";
import { extractProjectId, publishDemo } from "../skills/html-share/scripts/upload.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Phase 6 HTML Share Skill", () => {
  it("creates a stable manifest and reproducible ZIP without modifying the source", async () => {
    const directory = await fixture({
      "assets/logo.txt": "logo",
      "index.html": '<!doctype html><link href="assets/logo.txt"><h1>ready</h1>',
    });
    const original = await treeDigest(directory);
    const checked = await preflight({ publishDir: directory, targetHtml: "index.html" });
    expect(checked).toMatchObject({ fileCount: 2, status: "ready" });
    expect(checked.totalSize).toBeGreaterThan(0);
    const first = await packageDemo({ publishDir: directory, targetHtml: "index.html" });
    const second = await packageDemo({ publishDir: directory, targetHtml: "index.html" });
    try {
      expect(await readFile(first.archivePath)).toEqual(await readFile(second.archivePath));
      expect(await treeDigest(directory)).toBe(original);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  it("cleans only a marked HTML Share temporary archive", async () => {
    const directory = await fixture({ "index.html": "<h1>cleanup</h1>" });
    const packaged = await packageDemo({ publishDir: directory, targetHtml: "index.html" });
    await expect(cleanupArchive(packaged.archivePath, "wrong-token")).rejects.toThrow("标记不匹配");
    await packaged.cleanup();
    await expect(readFile(packaged.archivePath)).rejects.toThrow();
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

  it("keeps the preflight-approved file snapshot when a symlink changes before packaging", async () => {
    const directory = await fixture({
      "index.html": "<h1>safe</h1>",
      "inside.txt": "inside payload",
    });
    const outside = await fixture({ "outside.txt": "outside payload must never upload" });
    const linked = join(directory, "asset.txt");
    await symlink(join(directory, "inside.txt"), linked);
    const packaged = await packageDemo({
      onPackage: async () => {
        await unlink(linked);
        await symlink(join(outside, "outside.txt"), linked);
      },
      publishDir: directory,
      targetHtml: "index.html",
    });
    try {
      const archive = await readFile(packaged.archivePath, "utf8");
      expect(archive).toContain("inside payload");
      expect(archive).not.toContain("outside payload must never upload");
    } finally {
      await packaged.cleanup();
    }
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
      await writeFile(join(boundary, "file-" + index + ".txt"), "");
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

    const tooMany = await fixture({ "index.html": "ok" });
    for (let index = 1; index <= 500; index += 1) {
      await writeFile(join(tooMany, "file-" + index + ".txt"), "");
    }
    expect((await preflight({ publishDir: tooMany, targetHtml: "index.html" })).blocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "FILE_LIMIT" })]),
    );
  });

  it("requires an exact one-time acknowledgement for soft risks and invalidates it on changes", async () => {
    const directory = await fixture({
      "index.html":
        '<script src="/app.js"></script><img src="missing.png"><script>import(path)</script>',
    });
    const first = await preflight({ publishDir: directory, targetHtml: "index.html" });
    expect(first.status).toBe("confirmation_required");
    expect(first.risks.map((item) => item.id)).toEqual(
      expect.arrayContaining(["DYNAMIC_PATH", "MISSING_LOCAL_REFERENCE", "ROOT_ABSOLUTE_PATH"]),
    );
    await expect(
      packageDemo({
        publishDir: directory,
        riskAckDigest: "a".repeat(64),
        targetHtml: "index.html",
      }),
    ).rejects.toThrow("风险确认摘要不匹配");
    await writeFile(join(directory, "index.html"), '<script src="/changed.js"></script>');
    const changed = await preflight({ publishDir: directory, targetHtml: "index.html" });
    expect(changed.riskAckDigest).not.toBe(first.riskAckDigest);
  });

  it("uploads only the ZIP data plane, polls terminal state, and returns an exact link", async () => {
    const directory = await fixture({ "index.html": "<h1>published</h1>" });
    const calls = [];
    let statusChecks = 0;
    let transientCheck = true;
    const result = await publishDemo(
      {
        action: "create",
        demoUrl: "https://demo.example.test",
        displayName: "Smoke",
        mcpUrl: "https://app.example.test/mcp",
        publishDir: directory,
        targetHtml: "index.html",
        token: "token_not_logged",
      },
      {
        request: async (url, init = {}) => {
          if (String(url) === "https://storage.example.test/upload") {
            expect(init.method).toBe("PUT");
            expect(init.headers).toEqual({
              "content-length": "123",
              "content-type": "application/zip",
            });
            return { ok: true, status: 200 };
          }
          const body = JSON.parse(init.body);
          const name = body.params.name;
          calls.push(name);
          if (name === "check_connection" && transientCheck) {
            transientCheck = false;
            throw new TypeError("temporary network interruption");
          }
          const resultBody =
            name === "check_connection"
              ? { expiresAt: "2026-10-01T00:00:00.000Z", user: "Publisher" }
              : name === "prepare_demo_upload"
                ? {
                    project_id: "abc12",
                    status: "prepared",
                    upload_headers: { "content-length": "123", "content-type": "application/zip" },
                    upload_id: "d290f1ee-6c54-4b01-90e6-d701748f0851",
                    upload_url: "https://storage.example.test/upload",
                  }
                : name === "get_demo_upload_status"
                  ? {
                      project_id: "abc12",
                      status: statusChecks++ === 0 ? "processing" : "completed",
                      upload_id: "d290f1ee-6c54-4b01-90e6-d701748f0851",
                    }
                  : {
                      project_id: "abc12",
                      status: "processing",
                      upload_id: "d290f1ee-6c54-4b01-90e6-d701748f0851",
                    };
          return {
            json: async () => ({
              result: { content: [{ text: JSON.stringify(resultBody), type: "text" }] },
            }),
            ok: true,
            status: 200,
          };
        },
        sleep: async () => undefined,
      },
    );
    expect(calls).toEqual([
      "check_connection",
      "check_connection",
      "prepare_demo_upload",
      "complete_demo_upload",
      "get_demo_upload_status",
      "get_demo_upload_status",
    ]);
    expect(result).toEqual({
      projectId: "abc12",
      shareUrl: "https://demo.example.test/abc12/index.html",
      uploadId: "d290f1ee-6c54-4b01-90e6-d701748f0851",
    });
  });

  it("bounds a hanging MCP request and cleans the temporary ZIP", async () => {
    const directory = await fixture({ "index.html": "<h1>timeout</h1>" });
    await expect(
      publishDemo(
        {
          action: "create",
          demoUrl: "https://demo.example.test",
          mcpUrl: "https://app.example.test/mcp",
          publishDir: directory,
          requestTimeoutMs: 10,
          targetHtml: "index.html",
          token: "token_not_logged",
        },
        {
          request: async (_url, init) =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        },
      ),
    ).rejects.toThrow("请求超时");
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

async function treeDigest(directory) {
  const checked = await preflight({ publishDir: directory, targetHtml: "index.html" });
  return createHash("sha256").update(JSON.stringify(checked.files)).digest("hex");
}
