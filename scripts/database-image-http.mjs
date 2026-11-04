import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { directManifestDigest } from "./direct-upload-smoke-support.mjs";
import { imageRequest as request } from "./database-image-request.mjs";

// This client only talks to the fixed, isolated image-test port.
export async function exerciseDatabaseImage() {
  let assertions = 0;
  const check = (condition, message) => {
    assertions++;
    assert.ok(condition, message);
  };
  const start = await request("/auth/login?return_path=/demos");
  check(start.status === 302, "image starts simulator login");
  const callback = new URL(start.headers.get("location"));
  check(callback.hostname === "app.localhost", "callback stays on configured origin");
  const session = await request(callback.pathname + callback.search);
  check(session.status === 302, "image completes simulator login");
  const cookie = session.headers.get("set-cookie")?.split(";")[0];
  check(Boolean(cookie), "image returns session cookie");
  const csrf = await request("/api/csrf", { headers: { cookie } });
  check(csrf.status === 200, "image reads CSRF");
  const headers = {
    cookie,
    origin: "http://app.localhost:55530",
    "content-type": "application/json",
    "x-html-share-csrf": (await csrf.json()).csrfToken,
  };
  const tokenResponse = await request("/api/tokens", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Image contract" }),
  });
  check(tokenResponse.status === 201, "image creates Token");
  const token = await tokenResponse.json();
  const call = async (name, args) => {
    const response = await request("/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.value}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        id: randomUUID(),
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    check(response.status === 200, "image MCP returns HTTP 200");
    const body = await response.json();
    check(!body.error && body.result?.isError !== true, "image MCP succeeds");
    return JSON.parse(body.result.content.find((item) => item.type === "text").text);
  };
  const publish = async (version, projectId) => {
    const content = Buffer.from(`<!doctype html><h1>image version ${version} 中文😀</h1>`);
    const file = {
      relative_path: "首页.html",
      size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      content_md5: createHash("md5").update(content).digest("base64"),
      mime_type: "text/html; charset=utf-8",
    };
    const prepared = await call("prepare_demo_upload", {
      action: projectId ? "replace" : "create",
      client_request_id: randomUUID(),
      ...(projectId ? { project_id: projectId } : {}),
      display_name: "Image publication",
      access_mode: "password",
      files: [file],
      manifest_digest: directManifestDigest([file]),
      target_html: file.relative_path,
    });
    const upload = prepared.uploads[0];
    const target = new URL(upload.upload_url);
    check(target.origin === "http://127.0.0.1:59000", "PUT targets isolated MinIO");
    const put = await fetch(target, {
      method: "PUT",
      headers: upload.upload_headers,
      body: content,
    });
    check(put.ok, "direct object PUT succeeds");
    await call("complete_demo_upload", { upload_id: prepared.upload_id });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = await call("get_demo_upload_status", { upload_id: prepared.upload_id });
      if (status.status === "completed") return { ...status, project_id: prepared.project_id };
      check(status.status === "processing", "image upload remains processing until completion");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("image publication exceeded 60 seconds");
  };
  const first = await publish(1);
  check(first.access_mode === "password", "password publication commits");
  const next = await publish(2, first.project_id);
  const retained = await publish(3);
  check(
    retained.access_mode === "password",
    "image keeps an active password project for restore verification",
  );
  const id = first.project_id;
  check(next.project_id === id, "replace retains public identity");
  const detailResponse = await request(`/api/projects/${id}`, { headers: { cookie } });
  check(detailResponse.status === 200, "image reads owned detail");
  const detail = await detailResponse.json();
  check(detail.files[0].relativePath === "首页.html", "image preserves Unicode path");
  check(detail.project.accessMode === "password", "image preserves password mode");
  const list = await request("/api/projects", { headers: { cookie } });
  check(
    (await list.json()).projects.some((project) => project.projectId === id),
    "image lists project",
  );
  const home = await request(`/api/projects/${id}/homepage`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ relativePath: "首页.html" }),
  });
  check(home.status === 200, "image sets homepage");
  const denied = await request(`/${id}/${encodeURIComponent("首页.html")}`, {}, "demo");
  check(
    denied.status === 302 && (await denied.text()) === "",
    "unauthorized access returns zero file bytes",
  );
  const deleted = await request(`/api/projects/${id}/delete`, {
    method: "POST",
    headers,
    body: JSON.stringify({ confirmation: id }),
  });
  check(deleted.status === 200, "image deletes project");
  check(
    (await request(`/api/projects/${id}`, { headers: { cookie } })).status === 404,
    "deleted project immediately disappears",
  );
  const revoked = await request(`/api/tokens/${token.token.id}/revoke`, {
    method: "POST",
    headers,
    body: "{}",
  });
  check(revoked.status === 204, "image revokes Token");
  for (let attempt = 0; attempt < 30; attempt++) {
    const metrics = await fetch("http://127.0.0.1:55532/health/metrics").then((response) =>
      response.json(),
    );
    check(
      metrics.objectStorage.getObjectCalls === 0 && metrics.objectStorage.bodyBytesRead === 0,
      "container Worker never downloads object bodies",
    );
    // Project deletion waits until the last signed PUT expires plus its grace.
    // Pending future jobs cannot drain during this short smoke window.
    if (metrics.cleanup.running === 0 && metrics.cleanup.retrying === 0)
      return { assertions, cleanup: metrics.cleanup };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("image cleanup remained running or retrying");
}
