import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URLSearchParams } from "node:url";
import { promisify } from "node:util";

import { beginLockedPublication } from "./phase8-race-helper.mjs";
import {
  describeUploadFile,
  directManifestDigest,
  publicManifest,
  uploadPreparedFiles,
} from "./direct-upload-smoke-support.mjs";

const execute = promisify(execFile);
const appUrl = process.env.HTML_SHARE_APP_URL ?? "http://app.localhost:3001";
const appWebUrl = process.env.HTML_SHARE_APP_WEB_URL ?? "http://app.localhost:3000";
const demoUrl = process.env.HTML_SHARE_DEMO_URL ?? "http://demo.localhost:3001";
const composeProject = process.env.HTML_SHARE_COMPOSE_PROJECT;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function request(url, init = {}) {
  return fetch(url, { ...init, redirect: "manual" });
}

async function login() {
  const login = await request(`${appUrl}/auth/login?return_path=/demos`);
  const completed = await request(requiredHeader(login, "location"));
  const cookie = requiredHeader(completed, "set-cookie").split(";", 1)[0];
  const csrf = await request(`${appUrl}/api/csrf`, { headers: { cookie } });
  assert(csrf.status === 200, "app session must receive a CSRF token");
  const payload = await csrf.json();
  assert(typeof payload.csrfToken === "string", "CSRF token must be bound to app session");
  return { cookie, csrfToken: payload.csrfToken };
}

async function loginAs(code) {
  const started = await request(`${appUrl}/auth/internal/start`, {
    body: JSON.stringify({ returnPath: "/demos" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert(started.status === 200, "secondary session authorization must start");
  const { state } = await started.json();
  assert(typeof state === "string", "secondary session must include authorization state");
  const completed = await request(`${appUrl}/auth/internal/complete`, {
    body: JSON.stringify({ code, state }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const cookie = requiredHeader(completed, "set-cookie").split(";", 1)[0];
  const csrf = await request(`${appUrl}/api/csrf`, { headers: { cookie } });
  assert(csrf.status === 200, "secondary session must receive a CSRF token");
  const payload = await csrf.json();
  assert(typeof payload.csrfToken === "string", "secondary CSRF token must be bound to session");
  return { cookie, csrfToken: payload.csrfToken };
}

async function createMcpToken(session) {
  const response = await request(`${appUrl}/api/tokens`, {
    body: JSON.stringify({ name: "Phase 8 smoke" }),
    headers: {
      cookie: session.cookie,
      "content-type": "application/json",
      origin: appWebUrl,
      "x-html-share-csrf": session.csrfToken,
    },
    method: "POST",
  });
  const payload = await response.json();
  assert(
    response.status === 201,
    `MCP token creation must succeed: ${payload.error ?? response.status}`,
  );
  return payload.value;
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

async function publishFixture(token) {
  const directory = await mkdtemp(join(tmpdir(), "html-share-phase8-"));
  try {
    const html = "<!doctype html><title>Phase 8</title><h1>deletion fixture</h1>";
    await writeFile(join(directory, "index.html"), html);
    const files = [await describeUploadFile(join(directory, "index.html"), "index.html")];
    const prepared = await mcpCall(token, 1, "prepare_demo_upload", {
      action: "create",
      client_request_id: randomUUID(),
      display_name: "Phase 8 isolated fixture",
      files: publicManifest(files),
      manifest_digest: directManifestDigest(files),
      target_html: "index.html",
    });
    await uploadPreparedFiles(prepared, files);
    await mcpCall(token, 2, "complete_demo_upload", { upload_id: prepared.upload_id });
    await waitFor(
      `SELECT t.status || ':' || p.status FROM upload_tasks t JOIN demo_projects p ON p.id = t.project_id WHERE t.id = '${prepared.upload_id}'::uuid`,
      "COMPLETED:ACTIVE",
    );
    return prepared.project_id;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function createDemoSession(path) {
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

async function waitFor(sql, expected) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
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
      sql,
    ]);
    if (stdout.trim() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${expected}`);
}

function requiredHeader(response, name) {
  const value = response.headers.get(name);
  if (value === null) throw new Error(`${name} header missing`);
  return value;
}

const session = await login();
const token = await createMcpToken(session);
const projectId = await publishFixture(token);
const path = `/${projectId}/index.html`;
const demoCookie = await createDemoSession(path);
assert(
  (await request(`${demoUrl}${path}`, { headers: { cookie: demoCookie } })).status === 200,
  "fixture must be readable before deletion",
);

const nonOwner = await loginAs("simulator-member-002");
const unauthorizedDeletion = await request(`${appUrl}/api/projects/${projectId}/delete`, {
  body: JSON.stringify({ confirmation: projectId }),
  headers: {
    cookie: nonOwner.cookie,
    "content-type": "application/json",
    origin: appWebUrl,
    "x-html-share-csrf": nonOwner.csrfToken,
  },
  method: "POST",
});
assert(
  unauthorizedDeletion.status === 403,
  "non-owner deletion must be rejected by production SQL",
);
assert(
  (await request(`${demoUrl}${path}`, { headers: { cookie: demoCookie } })).status === 200,
  "rejected non-owner deletion must leave project content available",
);

const lookup = await request(`${appUrl}/api/admin/projects/${projectId}`, {
  headers: { cookie: session.cookie },
});
assert(lookup.status === 200, "configured administrator must perform exact lookup");

const raceStorageKey = `projects/${projectId}/race/published-during-delete.html`;
const publication = beginLockedPublication({
  composeProject,
  projectKey: projectId,
  storageKey: raceStorageKey,
});
await publication.locked;
const deletionPromise = request(`${appUrl}/api/admin/projects/${projectId}/delete`, {
  body: JSON.stringify({ reason: "Phase 8 isolated fixture cleanup verification." }),
  headers: {
    cookie: session.cookie,
    "content-type": "application/json",
    origin: appWebUrl,
    "x-html-share-csrf": session.csrfToken,
    "x-trace-id": "phase8-smoke",
  },
  method: "POST",
});
await publication.completed;
const deletion = await deletionPromise;
assert(
  deletion.status === 200 && (await deletion.json()).status === "deleted",
  "administrator deletion must succeed",
);
assert(
  (await request(`${demoUrl}${path}`, { headers: { cookie: demoCookie } })).status === 404,
  "deleted project content must immediately return 404",
);
const list = await request(`${appUrl}/api/projects`, { headers: { cookie: session.cookie } });
assert(
  !(await list.json()).projects.some((project) => project.projectId === projectId),
  "deleted project must leave owner list",
);
await waitFor(
  `SELECT status || ':' || total_size FROM demo_projects WHERE project_key = '${projectId}'`,
  "DELETED:0",
);
await waitFor(
  `SELECT action || ':' || trace_id FROM audit_logs WHERE trace_id = 'phase8-smoke' ORDER BY created_at DESC LIMIT 1`,
  "PROJECT_DELETE:phase8-smoke",
);
await waitFor(
  `SELECT status || ':' || (run_after >= (SELECT max(expires_at) + interval '1 minute' FROM upload_tasks WHERE project_id = (SELECT id FROM demo_projects WHERE project_key = '${projectId}'))) FROM cleanup_jobs WHERE kind = 'PROJECT' AND target_id = (SELECT id::text FROM demo_projects WHERE project_key = '${projectId}')`,
  "PENDING:true",
);
await waitFor(
  `SELECT CASE WHEN object_keys::text LIKE '%${raceStorageKey}%' THEN 'included' ELSE 'missing' END FROM cleanup_jobs WHERE kind = 'PROJECT' AND target_id = (SELECT id::text FROM demo_projects WHERE project_key = '${projectId}')`,
  "included",
);
await waitFor(
  `SELECT CASE WHEN (SELECT count(*) FROM upload_tasks WHERE project_id = (SELECT id FROM demo_projects WHERE project_key = '${projectId}')) > 0 THEN 'retained-until-signed-urls-expire' ELSE 'removed-too-early' END`,
  "retained-until-signed-urls-expire",
);

let limited;
for (let attempt = 0; attempt < 5; attempt += 1) {
  limited = await request(`${appUrl}/api/admin/projects/${projectId}/delete`, {
    body: JSON.stringify({ reason: "Phase 8 rate-limit audit verification." }),
    headers: {
      cookie: session.cookie,
      "content-type": "application/json",
      origin: appWebUrl,
      "x-html-share-csrf": session.csrfToken,
      "x-trace-id": "phase8-rate-limit",
    },
    method: "POST",
  });
}
assert(limited?.status === 429, "administrator deletion rate limit must reject the sixth request");
await waitFor(
  `SELECT action || ':' || trace_id FROM audit_logs WHERE trace_id = 'phase8-rate-limit' ORDER BY created_at DESC LIMIT 1`,
  "ADMIN_RATE_LIMITED:phase8-rate-limit",
);
console.log(JSON.stringify({ projectId, status: "phase8-delete-delayed-cleanup-ok" }));
