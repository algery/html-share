import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { capturePreparedCover } from "../skills/html-share/scripts/capture-cover.mjs";
import { preflight } from "../skills/html-share/scripts/preflight.mjs";
import { publishDemo } from "../skills/html-share/scripts/upload.mjs";
import { mcpHarness, publishInput } from "./phase6-mcp-harness.test-helper.mjs";

const homepage = "pages/欢迎.html";
const coverUrl = "https://objects.test/private/cover.jpg?signature=placeholder";
const exampleJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const directories = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

it("uses the server's effective homepage and uploads its exact JPEG before completing the Demo", async () => {
  const directory = await fixture();
  const mock = coverHarness({ homepage, uploadFails: 1 });

  const result = await publishDemo(publishInput(directory), mock);

  expect(result.shareUrl).toBe("https://demo.example.test/abc12/index.html");
  expect(mock.captureCover).toHaveBeenCalledWith(
    expect.objectContaining({ targetHtml: "index.html" }),
    "abc12",
    homepage,
  );
  expect(mock.events).toEqual([
    "check_connection",
    "prepare_demo_upload",
    "file",
    "file",
    "file",
    "file",
    "capture",
    "prepare_demo_cover",
    "cover",
    "cover",
    "complete_demo_upload",
    "get_demo_upload_status",
  ]);
  expect(mock.dataPlaneCalls).toHaveLength(2);
  for (const [url, options] of mock.dataPlaneCalls) {
    expect(url).toBe(coverUrl);
    expect(options).toMatchObject({
      body: exampleJpeg,
      method: "PUT",
      redirect: "error",
      headers: coverHeaders,
    });
  }
  expect(mock.signArgs).toEqual([
    {
      upload_id: "d290f1ee-6c54-4b01-90e6-d701748f0851",
      homepage_path: homepage,
      size: exampleJpeg.length,
      content_md5: coverHeaders["content-md5"],
    },
  ]);
});

it.each([undefined, null, "external/file.html", "assets/home.css"])(
  "preserves publication when the server supplies no usable cover homepage (%s)",
  async (coverHomepage) => {
    const directory = await fixture();
    const mock = coverHarness({ homepage: coverHomepage });
    await expect(publishDemo(publishInput(directory), mock)).resolves.toHaveProperty("shareUrl");
    expect(mock.captureCover).not.toHaveBeenCalled();
    expect(mock.events).not.toContain("prepare_demo_cover");
  },
);

it("skips a cover when the prepared task needs its remaining time to complete publication", async () => {
  const directory = await fixture();
  const mock = coverHarness({ homepage, expiresAt: new Date(Date.now() + 20_000).toISOString() });

  await expect(publishDemo(publishInput(directory), mock)).resolves.toHaveProperty("shareUrl");
  expect(mock.captureCover).not.toHaveBeenCalled();
  expect(mock.events).not.toContain("prepare_demo_cover");
  expect(mock.events.slice(-2)).toEqual(["complete_demo_upload", "get_demo_upload_status"]);
});

it.each(["capture", "signing", "headers", "upload"])(
  "completes the Demo when the optional cover fails during %s",
  async (failure) => {
    const directory = await fixture();
    const mock = coverHarness({
      homepage,
      captureFails: failure === "capture",
      signFails: failure === "signing",
      invalidHeaders: failure === "headers",
      uploadFails: failure === "upload" ? 2 : 0,
    });
    await expect(publishDemo(publishInput(directory), mock)).resolves.toHaveProperty("shareUrl");
    expect(mock.events.slice(-2)).toEqual(["complete_demo_upload", "get_demo_upload_status"]);
    expect(mock.dataPlaneCalls).toHaveLength(failure === "upload" ? 2 : 0);
  },
);

it("never attempts a screenshot before required risk confirmation", async () => {
  const directory = await fixture('<script src="https://resource.test/client.js"></script>');
  const mock = coverHarness({ homepage });
  await expect(publishDemo(publishInput(directory), mock)).rejects.toThrow("风险确认摘要不匹配");
  expect(mock.events).toEqual([]);
  expect(mock.captureCover).not.toHaveBeenCalled();

  const inspection = await preflight({ publishDir: directory, targetHtml: "index.html" });
  await writeFile(join(directory, ".env"), "placeholder");
  await expect(
    publishDemo({ ...publishInput(directory), riskAckDigest: inspection.riskAckDigest }, mock),
  ).rejects.toThrow("预检存在硬阻断");
  expect(mock.events).toEqual([]);
  expect(mock.captureCover).not.toHaveBeenCalled();
});

it("rejects an approved asset after its directory is replaced", async () => {
  const root = await fixture();
  const outside = await fixture();
  await configureBrowserRuntime();
  const checked = await preflight({ publishDir: root, targetHtml: "index.html" });
  await rm(join(root, "assets"), { recursive: true });
  await symlink(join(outside, "assets"), join(root, "assets"), "dir");
  await expect(capturePreparedCover(checked, "abc12", homepage)).rejects.toThrow("预检文件已变化");
});

it.runIf(process.env["HTML_SHARE_TEST_COVER_RENDERER"] === "1")(
  "renders a nested Unicode homepage and its static CSS and JS in sandboxed Chromium",
  async () => {
    await configureBrowserRuntime();
    const directory = await fixture();
    const inspection = await preflight({ publishDir: directory, targetHtml: "index.html" });
    const actual = await capturePreparedCover(inspection, "abc12", homepage);

    expect(actual).toBeInstanceOf(Buffer);
    expect(actual.length).toBeLessThanOrEqual(1024 * 1024);
    expect(actual.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(jpegDimensions(actual)).toEqual([960, 600]);
    const target = await capturePreparedCover(inspection, "abc12", "index.html");
    expect(actual.equals(target)).toBe(false);
  },
  30_000,
);

it.runIf(process.env["HTML_SHARE_TEST_COVER_RENDERER"] === "1")(
  "does not contact a loopback site from the browser and falls back for a blocked resource",
  async () => {
    await configureBrowserRuntime();
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      response.end("offline fixture");
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const root = await fixture(`<img src="http://127.0.0.1:${server.address().port}/cover.png">`);
      const checked = await preflight({ publishDir: root, targetHtml: "index.html" });
      expect(checked.status).toBe("confirmation_required");
      const published = await publishDemo(
        { ...publishInput(root), riskAckDigest: checked.riskAckDigest },
        { ...coverHarness({ homepage }), captureCover: capturePreparedCover },
      );
      expect(published.shareUrl).toBe("https://demo.example.test/abc12/index.html");
      expect(await capturePreparedCover(checked, "abc12", homepage)).toBeNull();
      expect(hits).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
  30_000,
);

const coverHeaders = {
  "content-length": String(exampleJpeg.length),
  "content-md5": createHash("md5").update(exampleJpeg).digest("base64"),
  "content-type": "image/jpeg",
};

function coverHarness(options) {
  const events = [];
  const dataPlaneCalls = [];
  const signArgs = [];
  const files = mcpHarness({ calls: events, onUpload: () => events.push("file") });
  return {
    dataPlaneCalls,
    events,
    signArgs,
    captureCover: vi.fn(async () => {
      events.push("capture");
      if (options.captureFails) throw new Error("fixture capture failed");
      return exampleJpeg;
    }),
    request: async (url, init) => {
      if (url === coverUrl) {
        events.push("cover");
        dataPlaneCalls.push([url, init]);
        return { ok: dataPlaneCalls.length > (options.uploadFails ?? 0) };
      }
      if (init.method === "PUT") return files.request(url, init);
      const { params } = JSON.parse(init.body);
      if (params.name === "prepare_demo_cover") {
        events.push(params.name);
        signArgs.push(params.arguments);
        return {
          ok: !options.signFails,
          json: async () => ({
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    upload_url: coverUrl,
                    upload_headers: options.invalidHeaders
                      ? { ...coverHeaders, "content-md5": "wrong" }
                      : coverHeaders,
                  }),
                },
              ],
            },
          }),
        };
      }
      const response = await files.request(url, init);
      if (params.name !== "prepare_demo_upload" || options.homepage === undefined) return response;
      const result = await response.json();
      const content = result.result.content[0];
      content.text = JSON.stringify({
        ...JSON.parse(content.text),
        cover_homepage: options.homepage,
        expires_at: options.expiresAt ?? new Date(Date.now() + 300_000).toISOString(),
      });
      return { ...response, json: async () => result };
    },
    sleep: files.sleep,
  };
}

async function fixture(extra = "") {
  const directory = await mkdtemp(join(tmpdir(), "demo-cover-skill-test-"));
  directories.push(directory);
  await mkdir(join(directory, "assets"));
  await mkdir(join(directory, "pages"));
  await writeFile(join(directory, "index.html"), "<!doctype html><h1>Published target</h1>");
  await writeFile(
    join(directory, homepage),
    `<!doctype html><meta charset=utf-8><link rel="stylesheet" href="../assets/home.css"><h1>Preview</h1><script src="../assets/home.js"></script>${extra}`,
  );
  await writeFile(join(directory, "assets/home.css"), "body {background:#164fac; color:white}");
  await writeFile(
    join(directory, "assets/home.js"),
    'document.querySelector("h1").textContent = "Dynamic preview";',
  );
  return directory;
}

async function configureBrowserRuntime() {
  const require = createRequire(import.meta.url);
  vi.stubEnv(
    "HTML_SHARE_COVER_RUNTIME",
    dirname(await realpath(require.resolve("@playwright/test/package.json"))),
  );
  vi.stubEnv(
    "PLAYWRIGHT_BROWSERS_PATH",
    process.env["PLAYWRIGHT_BROWSERS_PATH"] ??
      (process.platform === "darwin"
        ? join(homedir(), "Library/Caches/ms-playwright")
        : join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "ms-playwright")),
  );
}

function jpegDimensions(jpeg) {
  let offset = 2;
  while (offset + 8 < jpeg.length && jpeg[offset] === 0xff) {
    if (jpeg[offset + 1] === 0xc0 || jpeg[offset + 1] === 0xc2) {
      return [jpeg.readUInt16BE(offset + 7), jpeg.readUInt16BE(offset + 5)];
    }
    offset += 2 + jpeg.readUInt16BE(offset + 2);
  }
  throw new Error("JPEG dimensions unavailable");
}
