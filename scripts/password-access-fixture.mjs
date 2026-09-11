import { mimeForPath } from "../packages/core/dist/index.js";
import { createHash, randomUUID } from "node:crypto";
import { directManifestDigest } from "./direct-upload-smoke-support.mjs";

export async function publishAccessFixture(h, check, overrides = {}) {
  const bodies = new Map([
    [
      "nested/测试 file.html",
      Buffer.from(
        '<!doctype html><html><head><title>Password fixture</title><link rel="stylesheet" href="../assets/style.css"><script defer src="../assets/app.js"></script></head><body><h1 id="fixture">Protected fixture</h1><img id="asset" src="../assets/pixel.png"></body></html>',
      ),
    ],
    ["assets/style.css", Buffer.from("body{color:rgb(12,34,56)}")],
    ["assets/app.js", Buffer.from('document.documentElement.dataset.loaded="yes";')],
    [
      "assets/pixel.png",
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY9sAAAAASUVORK5CYII=",
        "base64",
      ),
    ],
  ]);
  const files = [...bodies].map(([relative_path, body]) => ({
    relative_path,
    size: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    content_md5: createHash("md5").update(body).digest("base64"),
    mime_type: mimeForPath(relative_path),
  }));
  const prepared = await h.call("prepare_demo_upload", {
    action: "create",
    client_request_id: randomUUID(),
    display_name: "Password access fixture",
    target_html: files[0].relative_path,
    files,
    manifest_digest: directManifestDigest(files),
    access_mode: "password",
    ...overrides,
  });
  for (const upload of prepared.uploads) {
    const response = await fetch(upload.upload_url, {
      method: "PUT",
      headers: upload.upload_headers,
      body: bodies.get(upload.relative_path),
    });
    const failureCode = response.ok
      ? ""
      : ((await response.text()).match(/<Code>([A-Za-z0-9]+)<\/Code>/)?.[1] ?? "unknown");
    check(
      response.ok,
      `private object upload succeeded (status=${response.status}, code=${failureCode})`,
    );
  }
  await h.call("complete_demo_upload", { upload_id: prepared.upload_id });
  check((await h.finalize()) === "published", "real finalizer publishes fixture");
  const result = await h.call("get_demo_upload_status", { upload_id: prepared.upload_id });
  check(result.status === "completed", "MCP returns completed");
  const targetPath = new URL(result.target_url).pathname + "?preview=a%20b";
  return { result, targetPath, bodies };
}

export function responseCookies(response) {
  const cookies = response.headers["set-cookie"] ?? [];
  return (Array.isArray(cookies) ? cookies : [cookies])
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

export function responseState(response) {
  const state = response.body.toString().match(/"state":"([A-Za-z0-9_.-]+)"/)?.[1];
  if (!state) throw new Error("Password response state missing");
  return state;
}
