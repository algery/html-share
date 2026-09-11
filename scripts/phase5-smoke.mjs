import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URLSearchParams } from "node:url";
import { promisify } from "node:util";

import {
  describeUploadFile,
  directManifestDigest,
  publicManifest,
  uploadPreparedFiles,
} from "./direct-upload-smoke-support.mjs";

const execute = promisify(execFile);
const appUrl = process.env.HTML_SHARE_APP_URL ?? "http://app.localhost:3001";
const demoUrl = process.env.HTML_SHARE_DEMO_URL ?? "http://demo.localhost:3001";
const appWebUrl = process.env.HTML_SHARE_APP_WEB_URL ?? "http://app.localhost:3000";
const composeProject = process.env.HTML_SHARE_COMPOSE_PROJECT;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function request(url, init = {}) {
  return fetch(url, { ...init, redirect: "manual" });
}

async function createToken() {
  const login = await request(`${appUrl}/auth/login?return_path=/tokens`);
  const completed = await request(requiredHeader(login, "location"));
  const cookie = requiredHeader(completed, "set-cookie").split(";", 1)[0];
  const csrf = await request(`${appUrl}/api/csrf`, { headers: { cookie } });
  assert(csrf.status === 200, "CSRF token creation must succeed");
  const csrfToken = (await csrf.json()).csrfToken;
  const token = await request(`${appUrl}/api/tokens`, {
    body: JSON.stringify({ name: "Phase 5 smoke" }),
    headers: {
      cookie,
      "content-type": "application/json",
      origin: appWebUrl,
      "x-html-share-csrf": csrfToken,
    },
    method: "POST",
  });
  assert(token.status === 201, "token creation must succeed");
  return (await token.json()).value;
}

async function mcpCall(token, id, name, args) {
  const response = await request(`${appUrl}/mcp`, {
    body: JSON.stringify({
      id,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: args, name },
    }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    },
    method: "POST",
  });
  assert(response.status === 200, `MCP ${name} must return 200`);
  const body = await response.json();
  const text = body.result?.content?.find((item) => item.type === "text")?.text;
  assert(typeof text === "string", `MCP ${name} text result must exist`);
  return JSON.parse(text);
}

async function publish() {
  const directory = await mkdtemp(join(tmpdir(), "html-share-phase5-"));
  try {
    const html = "<!doctype html><title>Phase 5</title><h1>content gateway</h1>";
    await writeFile(join(directory, "index.html"), html);
    const contentHash = createHash("sha256").update(html).digest("hex");
    const files = [await describeUploadFile(join(directory, "index.html"), "index.html")];
    const token = await createToken();
    const prepared = await mcpCall(token, 1, "prepare_demo_upload", {
      action: "create",
      client_request_id: randomUUID(),
      display_name: "Phase 5 smoke",
      files: publicManifest(files),
      manifest_digest: directManifestDigest(files),
      target_html: "index.html",
    });
    await uploadPreparedFiles(prepared, files);
    await mcpCall(token, 2, "complete_demo_upload", { upload_id: prepared.upload_id });
    await waitForPublishedUpload(prepared.upload_id);
    return { contentHash, html, projectId: prepared.project_id };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function createDemoSession(returnPath) {
  const login = await request(
    `${demoUrl}/auth/content-login?return_path=${encodeURIComponent(returnPath)}`,
  );
  assert(login.status === 200, "Demo content authorization must load the in-app bridge");
  const loginPage = await login.text();
  assert(
    loginPage.includes("requestAuthCode"),
    "Demo login must request DingTalk in-app auth code",
  );
  assert(loginPage.includes("/auth/internal/complete"), "Demo login must complete in-app auth");
  const state = loginPage.match(/"state":"([A-Za-z0-9_-]+)"/)?.[1];
  assert(typeof state === "string", "Demo content authorization state must be signed");
  const completed = await request(`${demoUrl}/auth/internal/complete`, {
    body: new URLSearchParams({ code: "simulator-member", state }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", origin: demoUrl },
    method: "POST",
  });
  assert(completed.status === 302, "Demo in-app authorization must complete");
  assert(
    requiredHeader(completed, "location") === `${demoUrl}${returnPath}`,
    "must restore exact path",
  );
  return requiredHeader(completed, "set-cookie").split(";", 1)[0];
}

const published = await publish();
const exactPath = `/${published.projectId}/index.html`;
const unauthenticated = await request(`${demoUrl}${exactPath}`);
assert(unauthenticated.status === 302, "unauthenticated content must enter authorization");
assert(
  (await unauthenticated.text()) === "",
  "unauthenticated content must contain no object bytes",
);
const cookie = await createDemoSession(exactPath);
const get = await request(`${demoUrl}${exactPath}`, { headers: { cookie } });
assert(get.status === 200, "authorized GET must return content");
const getBody = await get.text();
assert(getBody === published.html, "GET must preserve original bytes");
assert(get.headers.get("content-type") === "text/html; charset=utf-8", "MIME must be trusted");
assert(get.headers.get("x-content-type-options") === "nosniff", "nosniff must be present");
assert(get.headers.get("x-robots-tag") === "noindex", "noindex must be present");
assert(get.headers.get("referrer-policy") === "no-referrer", "no-referrer must be present");
const head = await request(`${demoUrl}${exactPath}`, { headers: { cookie }, method: "HEAD" });
assert(head.status === 200, "authorized HEAD must return metadata");
assert(head.headers.get("etag") === get.headers.get("etag"), "HEAD and GET ETags must match");
assert(
  head.headers.get("content-length") === get.headers.get("content-length"),
  "HEAD and GET sizes must match",
);
const cached = await request(`${demoUrl}${exactPath}`, {
  headers: { cookie, "if-none-match": requiredHeader(get, "etag") },
});
assert(cached.status === 304, "matching ETag must return 304");
const invalidPaths = [
  `/${published.projectId}`,
  `/${published.projectId}/missing.html`,
  `/${published.projectId}/%2e%2e/index.html`,
  `/${published.projectId}/%252e%252e/index.html`,
  `/${published.projectId}/%00index.html`,
  `/${published.projectId}%5c/index.html`,
];
const invalidResponses = await Promise.all(
  invalidPaths.map((path) => request(`${demoUrl}${path}`, { headers: { cookie } })),
);
const invalidBodies = await Promise.all(invalidResponses.map((response) => response.text()));
for (const response of invalidResponses)
  assert(response.status === 404, "invalid paths must be uniform 404");
assert(new Set(invalidBodies).size === 1, "404 pages must not reveal project state");
console.log(
  JSON.stringify({
    attackStatuses: invalidResponses.map((response) => response.status),
    bytes: Buffer.byteLength(getBody),
    cached: { etag: cached.headers.get("etag"), status: cached.status },
    get: {
      contentLength: get.headers.get("content-length"),
      contentType: get.headers.get("content-type"),
      etag: get.headers.get("etag"),
      status: get.status,
    },
    head: {
      contentLength: head.headers.get("content-length"),
      contentType: head.headers.get("content-type"),
      etag: head.headers.get("etag"),
      status: head.status,
    },
    projectId: published.projectId,
    status: "phase5-content-gateway-ok",
    unauthenticated: { bodyBytes: 0, status: unauthenticated.status },
  }),
);

function requiredHeader(response, name) {
  const value = response.headers.get(name);
  if (value === null) throw new Error(`${name} header missing`);
  return value;
}

async function waitForPublishedUpload(uploadId) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const { stdout } = await execute("docker", [
      "compose",
      ...(composeProject === undefined ? [] : ["--project-name", composeProject]),
      "--env-file",
      ".env.example",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "html_share",
      "-d",
      "html_share",
      "-At",
      "-c",
      `SELECT t.status || ':' || r.status FROM upload_tasks t JOIN revisions r ON r.id = t.revision_id WHERE t.id = '${uploadId}'::uuid`,
    ]);
    if (stdout.trim() === "COMPLETED:ACTIVE") return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("worker did not publish the Phase 5 smoke upload");
}
