import { createHash } from "node:crypto";
import { directManifestDigest } from "./direct-upload-smoke-support.mjs";
import { fixture } from "./password-smoke-fixture.mjs";

export async function publishBrowserFixture(h, check) {
  const input = fixture("phase26", {
    access_mode: "password",
    display_name: "Phase26 中文😀 浏览器项目",
  });
  const path = "首页 😀.html";
  const body = Buffer.from("<!doctype html><title>Phase26</title><h1>Alternate homepage</h1>");
  input.bodies.set(path, body);
  input.args.files.push({
    relative_path: path,
    size: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    content_md5: createHash("md5").update(body).digest("base64"),
    mime_type: "text/html; charset=utf-8",
  });
  input.args.manifest_digest = directManifestDigest(input.args.files);
  const prepared = await h.call("prepare_demo_upload", input.args);
  for (const upload of prepared.uploads) {
    const response = await fetch(upload.upload_url, {
      method: "PUT",
      headers: upload.upload_headers,
      body: input.bodies.get(upload.relative_path),
    });
    check(response.ok, "Browser fixture private PUT succeeds");
  }
  await h.call("complete_demo_upload", { upload_id: prepared.upload_id });
  check((await h.finalize()) === "published", "Real worker publishes browser fixture");
  return {
    result: await h.call("get_demo_upload_status", { upload_id: prepared.upload_id }),
    alternate: path,
  };
}
