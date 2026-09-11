import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import {
  describeUploadFile,
  directManifestDigest,
  publicManifest,
  uploadPreparedFiles,
} from "./direct-upload-smoke-support.mjs";

const execute = promisify(execFile);
const appUrl = process.env.HTML_SHARE_APP_URL ?? "http://app.localhost:3001";
const appWebUrl = process.env.HTML_SHARE_APP_WEB_URL ?? "http://app.localhost:3000";
const composeProject = process.env.HTML_SHARE_COMPOSE_PROJECT;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(url, init = {}) {
  return fetch(url, { ...init, redirect: "manual" });
}

async function createToken() {
  const login = await request(`${appUrl}/auth/login?return_path=/tokens`);
  const callback = login.headers.get("location");
  assert(callback !== null, "app authorization callback must be present");
  const completed = await request(callback);
  const cookie = completed.headers.get("set-cookie");
  assert(cookie !== null, "app session cookie must be present");
  const sessionCookie = cookie.split(";", 1)[0];
  const csrf = await request(`${appUrl}/api/csrf`, { headers: { cookie: sessionCookie } });
  assert(csrf.status === 200, "CSRF token creation must succeed");
  const csrfToken = (await csrf.json()).csrfToken;
  const token = await request(`${appUrl}/api/tokens`, {
    body: JSON.stringify({ name: "Phase 4 smoke" }),
    headers: {
      cookie: sessionCookie,
      "content-type": "application/json",
      origin: appWebUrl,
      "x-html-share-csrf": csrfToken,
    },
    method: "POST",
  });
  assert(token.status === 201, "Token creation must succeed");
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
  assert(body.error === undefined, `MCP ${name} must not return a protocol error`);
  const text = body.result?.content?.find((item) => item.type === "text")?.text;
  assert(typeof text === "string", `MCP ${name} text result must exist`);
  return JSON.parse(text);
}

const directory = await mkdtemp(join(tmpdir(), "html-share-phase4-"));
try {
  const html = "<!doctype html><title>Phase 4</title><h1>published</h1>";
  await writeFile(join(directory, "index.html"), html);
  const files = [await describeUploadFile(join(directory, "index.html"), "index.html")];
  const token = await createToken();
  const prepared = await mcpCall(token, 1, "prepare_demo_upload", {
    action: "create",
    client_request_id: randomUUID(),
    display_name: "Phase 4 smoke",
    files: publicManifest(files),
    manifest_digest: directManifestDigest(files),
    target_html: "index.html",
  });
  await uploadPreparedFiles(prepared, files);
  const completed = await mcpCall(token, 2, "complete_demo_upload", {
    upload_id: prepared.upload_id,
  });
  assert(completed.status === "processing", "complete must enqueue server-side validation");
  const status = await waitForPublishedUpload(prepared.upload_id);
  assert(status === "COMPLETED:ACTIVE:1", `worker must publish an active revision, got ${status}`);
  console.log(
    JSON.stringify({ projectId: prepared.project_id, status, uploadId: prepared.upload_id }),
  );
} finally {
  await rm(directory, { force: true, recursive: true });
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
      `SELECT t.status || ':' || r.status || ':' || count(f.id)
       FROM upload_tasks t
       JOIN revisions r ON r.id = t.revision_id
       LEFT JOIN file_objects f ON f.revision_id = r.id
       WHERE t.id = '${uploadId}'::uuid
       GROUP BY t.status, r.status`,
    ]);
    const status = stdout.trim();
    if (status === "COMPLETED:ACTIVE:1") return status;
    if (status.startsWith("FAILED:") || status.startsWith("EXPIRED:")) return status;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("worker did not finalize the upload within the smoke-test deadline");
}
