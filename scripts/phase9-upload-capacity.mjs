import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { URLSearchParams } from "node:url";
import { promisify } from "node:util";

import {
  describeUploadFile,
  directManifestDigest,
  publicManifest,
} from "./direct-upload-smoke-support.mjs";
import { cleanupTemporary, uploadDirectFiles } from "./phase9-upload-capacity-support.mjs";

const execute = promisify(execFile);
const appUrl = process.env.HTML_SHARE_APP_URL ?? "http://app.localhost:3001";
const appWebUrl = process.env.HTML_SHARE_APP_WEB_URL ?? "http://app.localhost:3000";
const demoUrl = process.env.HTML_SHARE_DEMO_URL ?? "http://demo.localhost:3001";
const uploadCount = 10;
const timeoutMs = 5_000;
const requestTimeoutMs = 10_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(url, init = {}) {
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
  } catch (error) {
    const target = new URL(url);
    const outcome = error instanceof Error && error.name === "AbortError" ? "timed out" : "failed";
    throw new Error(`local HTTP ${target.origin}${target.pathname} ${outcome}`);
  } finally {
    clearTimeout(timeout);
  }
}

function requiredHeader(response, name) {
  const value = response.headers.get(name);
  if (value === null) throw new Error(`${name} header missing`);
  return value;
}

async function login() {
  const started = await request(`${appUrl}/auth/login?return_path=/tokens`);
  const completed = await request(requiredHeader(started, "location"));
  const cookie = requiredHeader(completed, "set-cookie").split(";", 1)[0];
  const csrf = await request(`${appUrl}/api/csrf`, { headers: { cookie } });
  assert(csrf.status === 200, "CSRF token creation must succeed");
  return { cookie, csrfToken: (await csrf.json()).csrfToken };
}

async function createDemoCookie() {
  const path = "/abc12/index.html";
  const login = await request(
    `${demoUrl}/auth/content-login?return_path=${encodeURIComponent(path)}`,
  );
  const page = await login.text();
  const state = page.match(/"state":"([A-Za-z0-9_-]+)"/)?.[1];
  assert(typeof state === "string", "Demo authorization state must exist");
  const completed = await request(`${demoUrl}/auth/internal/complete`, {
    body: new URLSearchParams({ code: "simulator-member", state }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", origin: demoUrl },
    method: "POST",
  });
  return requiredHeader(completed, "set-cookie").split(";", 1)[0];
}

async function createMcpToken(session) {
  const response = await request(`${appUrl}/api/tokens`, {
    body: JSON.stringify({ name: "Phase 9 local upload capacity" }),
    headers: {
      cookie: session.cookie,
      "content-type": "application/json",
      origin: appWebUrl,
      "x-html-share-csrf": session.csrfToken,
    },
    method: "POST",
  });
  assert(response.status === 201, "MCP token creation must succeed");
  const created = await response.json();
  assert(
    typeof created?.token?.id === "string" && typeof created?.value === "string",
    "MCP token response must contain an id and one-time value",
  );
  return { id: created.token.id, value: created.value };
}

async function revokeMcpToken(session, tokenId) {
  const response = await request(`${appUrl}/api/tokens/${tokenId}/revoke`, {
    headers: {
      cookie: session.cookie,
      origin: appWebUrl,
      "x-html-share-csrf": session.csrfToken,
    },
    method: "POST",
  });
  assert(response.status === 204, "temporary MCP token revocation must succeed");
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
  const text = (await response.json()).result?.content?.find((item) => item.type === "text")?.text;
  assert(typeof text === "string", `MCP ${name} must return JSON text`);
  return JSON.parse(text);
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "html-share-phase9-upload-"));
  const html = "<!doctype html><title>Phase 9</title><h1>capacity fixture</h1>";
  await writeFile(join(directory, "index.html"), html);
  const files = [await describeUploadFile(join(directory, "index.html"), "index.html")];
  return { directory, files, html, manifestDigest: directManifestDigest(files) };
}

async function readPublishedFile(projectId, cookie) {
  return request(`${demoUrl}/${projectId}/index.html`, { headers: { cookie } });
}

async function waitForPublished(token, prepared, cookie) {
  const startedAt = performance.now();
  // Three polls keep ten complete flows within the 60 MCP calls/minute Token limit.
  for (const delayMs of [1_500, 1_500, 1_500]) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const status = await mcpCall(token, randomUUID(), "get_demo_upload_status", {
      upload_id: prepared.upload_id,
    });
    if (status.status === "completed") {
      const content = await readPublishedFile(prepared.project_id, cookie);
      assert(content.status === 200, "completed upload must be readable");
      assert(
        (await content.text()) === prepared.expectedHtml,
        "published fixture content must match",
      );
      return performance.now() - startedAt;
    }
    if (status.status === "failed" || status.status === "expired") {
      throw new Error(`upload ended as ${status.status}`);
    }
  }
  throw new Error("upload did not publish within five seconds");
}

async function runUpload(token, fixture, demoCookie, index) {
  const startedAt = performance.now();
  const prepared = await mcpCall(token, `prepare-${index}`, "prepare_demo_upload", {
    action: "create",
    client_request_id: randomUUID(),
    display_name: `Phase 9 capacity ${index + 1}`,
    files: publicManifest(fixture.files),
    manifest_digest: fixture.manifestDigest,
    target_html: "index.html",
  });
  await uploadDirectFiles({ execute, files: fixture.files, prepared });
  const pending = await readPublishedFile(prepared.project_id, demoCookie);
  assert(pending.status === 404, "upload must remain invisible before completion");
  const completed = await mcpCall(token, `complete-${index}`, "complete_demo_upload", {
    upload_id: prepared.upload_id,
  });
  assert(
    completed.status === "processing" || completed.status === "completed",
    "upload completion must be accepted",
  );
  const completionToPublishedMs = await waitForPublished(
    token,
    { ...prepared, expectedHtml: fixture.html },
    demoCookie,
  );
  return { completionToPublishedMs, uploadEndToEndMs: performance.now() - startedAt };
}

function percentile95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

let fixture;
let runError;
let sessionCookie;
let temporaryToken;
try {
  sessionCookie = await login();
  const demoCookie = await createDemoCookie();
  temporaryToken = await createMcpToken(sessionCookie);
  fixture = await createFixture();
  const durations = await Promise.all(
    Array.from({ length: uploadCount }, (_, index) =>
      runUpload(temporaryToken.value, fixture, demoCookie, index),
    ),
  );
  const completionToPublishedP95Ms = percentile95(
    durations.map((duration) => duration.completionToPublishedMs),
  );
  const uploadEndToEndP95Ms = percentile95(durations.map((duration) => duration.uploadEndToEndMs));
  assert(
    completionToPublishedP95Ms < timeoutMs,
    "completion-to-published P95 must remain below five seconds",
  );
  assert(uploadEndToEndP95Ms < 60_000, "upload end-to-end P95 must remain below sixty seconds");
  console.log(
    JSON.stringify({
      completedUploads: durations.length,
      pendingReads404: durations.length,
      publishedReads200: durations.length,
      completionToPublishedP95Ms: Number(completionToPublishedP95Ms.toFixed(2)),
      uploadEndToEndP95Ms: Number(uploadEndToEndP95Ms.toFixed(2)),
    }),
  );
} catch (error) {
  const reason = error instanceof Error ? error.message : "unknown error";
  runError = new Error(`local upload capacity validation failed: ${reason.slice(0, 240)}`);
}

const cleanupErrors = await cleanupTemporary({
  fixture,
  removeDirectory: (directory) => rm(directory, { force: true, recursive: true }),
  report: (result) => console.log(JSON.stringify(result)),
  revokeToken: revokeMcpToken,
  sessionCookie,
  temporaryToken,
});
if (cleanupErrors.length > 0) throw new Error(cleanupErrors.join("; "));
if (runError !== undefined) throw runError;
