import { describe, expect, it } from "vitest";
import { homepageLink, resolveHomepage } from "./homepage.js";

describe("management homepage selection", () => {
  it.each([
    [["index.html", "other.html"], null, "index.html", "automatic"],
    [["assets/app.js", "目录/唯一.HTM"], null, "目录/唯一.HTM", "automatic"],
    [["a.html", "b.html"], null, null, "ambiguous"],
    [["assets/app.js"], null, null, "none"],
    [["index.html", "a.html"], "a.html", "a.html", "manual"],
    [["index.html"], "old.html", null, "missing"],
    [["index.html", "style.css"], "style.css", null, "missing"],
    [["Index.html", "page.html"], null, null, "ambiguous"],
  ] as const)("resolves %j with %s", (paths, configured, path, source) => {
    expect(resolveHomepage(paths, configured)).toEqual({ path, source });
  });
  it("encodes each exact path segment and never returns a project root as a homepage", () => {
    const path = "中文目录/页面 #?%.html";
    expect(homepageLink([path], null, "abc12", "http://demo.localhost:3001").url).toBe(
      `http://demo.localhost:3001/abc12/${path.split("/").map(encodeURIComponent).join("/")}`,
    );
    expect(homepageLink([], null, "abc12", "http://demo.localhost:3001").url).toBeNull();
  });
});
