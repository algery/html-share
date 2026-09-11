import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { MAX_DEMO_FILE_BYTES, MAX_DEMO_FILES, MAX_DEMO_TOTAL_BYTES } from "./contracts.js";
import { digestManifest, mimeForPath, validateManifest } from "./manifest-validator.js";

describe("validateManifest", () => {
  it("accepts 500 files and an exact 20 MiB total", () => {
    const regularSize = Math.floor(MAX_DEMO_TOTAL_BYTES / MAX_DEMO_FILES);
    const files = Array.from({ length: MAX_DEMO_FILES }, (_, index) =>
      file(
        index === 0 ? "index.html" : `assets/${index}.bin`,
        index === MAX_DEMO_FILES - 1
          ? MAX_DEMO_TOTAL_BYTES - regularSize * (MAX_DEMO_FILES - 1)
          : regularSize,
      ),
    );
    expect(validate(files).totalSize).toBe(MAX_DEMO_TOTAL_BYTES);
  });

  it("accepts a declared target HTML with zero bytes", () => {
    expect(validate([file("index.html", 0)]).totalSize).toBe(0);
  });

  it.each([
    ["no files", []],
    [
      "more than 500 files",
      Array.from({ length: MAX_DEMO_FILES + 1 }, (_, index) => file(`${index}.html`, 1)),
    ],
    ["single file above 5 MiB", [file("index.html", MAX_DEMO_FILE_BYTES + 1)]],
    [
      "total above 20 MiB",
      [
        file("index.html", MAX_DEMO_FILE_BYTES),
        ...Array.from({ length: 4 }, (_, index) => file(`${index}.bin`, MAX_DEMO_FILE_BYTES)),
        file("extra.bin", 1),
      ],
    ],
  ])("rejects %s", (_name, files) => {
    expect(() => validate(files)).toThrowError("INVALID_UPLOAD_INPUT");
  });

  it.each([
    "../index.html",
    "/index.html",
    "a//index.html",
    "a\\index.html",
    "./index.html",
    "assets/a%2Fb.png",
    "index%2e.html",
    "nul%00.html",
    "slash%5c.html",
  ])("rejects unsafe path %s", (relativePath) => {
    const files = [file(relativePath, 1)];
    expect(() => validate(files, relativePath)).toThrowError("INVALID_UPLOAD_INPUT");
  });

  it("rejects duplicate paths, missing target, MIME drift, MD5 drift, and digest drift", () => {
    const index = file("index.html", 1);
    const cases = [
      { files: [index, index], target: "index.html" },
      { files: [index], target: "missing.html" },
      { files: [{ ...index, mimeType: "application/octet-stream" }], target: "index.html" },
      { files: [{ ...index, contentMd5: "invalid" }], target: "index.html" },
    ];
    for (const current of cases) {
      expect(() => validate(current.files, current.target)).toThrowError("INVALID_UPLOAD_INPUT");
    }
    expect(() =>
      validateManifest({
        files: [index],
        manifestDigest: "0".repeat(64),
        targetHtml: "index.html",
      }),
    ).toThrowError("INVALID_UPLOAD_INPUT");
  });

  it("derives MIME from path and makes digest independent of input order", () => {
    const files = [file("styles/site.css", 2), file("index.html", 1)];
    expect(digestManifest(files)).toBe(digestManifest([...files].reverse()));
    expect(mimeForPath("image.PNG")).toBe("image/png");
    expect(mimeForPath("asset.unknown")).toBe("application/octet-stream");
  });
});

function validate(files: ReturnType<typeof file>[], targetHtml = "index.html") {
  return validateManifest({ files, manifestDigest: digestManifest(files), targetHtml });
}

function file(relativePath: string, size: number) {
  const seed = `${relativePath}:${size}`;
  return {
    contentMd5: createHash("md5").update(seed).digest("base64"),
    mimeType: mimeForPath(relativePath),
    relativePath,
    sha256: createHash("sha256").update(seed).digest("hex"),
    size,
  };
}
