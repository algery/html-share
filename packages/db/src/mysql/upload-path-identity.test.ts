import { describe, expect, it, vi } from "vitest";
import { textDigest } from "./path-identity.js";
import { assertManifestIdentity, assertStoredUploadFiles } from "./upload-path-identity.js";

vi.mock("./path-identity.js", async (original) => {
  const actual = await original<typeof import("./path-identity.js")>();
  return { ...actual, textDigest: vi.fn(actual.textDigest) };
});

const file = (relativePath: string) => ({
  relativePath,
  size: 1,
  mimeType: "text/html",
  sha256: "a".repeat(64),
  contentMd5: "ndTkYSaMgDT1yFZOFVxnpg==",
});

describe("MySQL upload full path identity", () => {
  it("keeps Unicode, case and same-prefix 1024-unit names distinct", () => {
    const prefix = "中文😀/" + "a".repeat(1013);
    const files = [file(`${prefix}A.html`), file(`${prefix}a.html`)];
    expect(files[0]?.relativePath.length).toBe(1024);
    expect(() => assertManifestIdentity(files)).not.toThrow();
    expect(vi.mocked(textDigest).mock.results[0]?.value).not.toEqual(
      vi.mocked(textDigest).mock.results[1]?.value,
    );
    expect(() =>
      assertStoredUploadFiles(
        files.map(({ relativePath }) => ({
          relativePath,
          storageKey: `projects/project/revisions/revision/${relativePath}`,
        })),
        files,
        "project",
        "revision",
      ),
    ).not.toThrow();
  });

  it("refuses an injected digest collision before returning upload addresses", () => {
    vi.mocked(textDigest)
      .mockReturnValueOnce(Buffer.alloc(32))
      .mockReturnValueOnce(Buffer.alloc(32));
    expect(() => assertManifestIdentity([file("A.html"), file("a.html")])).toThrow(
      "INVALID_UPLOAD_INPUT",
    );
  });

  it("refuses a returned full path or object key belonging to another file", () => {
    expect(() =>
      assertStoredUploadFiles(
        [{ relativePath: "A.html", storageKey: "projects/project/revisions/revision/a.html" }],
        [file("A.html")],
        "project",
        "revision",
      ),
    ).toThrow("identity");
    expect(() =>
      assertStoredUploadFiles(
        [{ relativePath: "a.html", storageKey: "projects/project/revisions/revision/a.html" }],
        [file("A.html")],
        "project",
        "revision",
      ),
    ).toThrow("INVALID_UPLOAD_INPUT");
  });
});
