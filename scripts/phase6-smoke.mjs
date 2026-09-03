import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { URLSearchParams } from "node:url";
import { promisify } from "node:util";

import { buildDistributions } from "../skills/build-distributions.mjs";
import { preflight } from "../skills/html-share/scripts/preflight.mjs";
import { publishDemo } from "../skills/html-share/scripts/upload.mjs";

const execute = promisify(execFile);
const appUrl = "http://app.localhost:3001";
const appWebUrl = "http://app.localhost:3000";
const demoUrl = "http://demo.localhost:3001";

const startedAt = performance.now();
const directory = await mkdtemp(join(tmpdir(), "html-share-phase6-smoke-"));
try {
  await buildDistributions();
  await assertPackages();
  const token = await createToken();
  const cleanDir = join(directory, "clean");
  await (await import("node:fs/promises")).mkdir(cleanDir);
  await writeFile(join(cleanDir, "index.html"), "<!doctype html><h1>version one</h1>");
  const cleanBefore = await digestDirectory(cleanDir);
  const first = await publishDemo({
    action: "create",
    demoUrl,
    displayName: "Phase 6 clean",
    mcpUrl: appUrl + "/mcp",
    publishDir: cleanDir,
    targetHtml: "index.html",
    token,
    uploadHostOverride: "127.0.0.1",
  });
  assert(
    (await digestDirectory(cleanDir)) === cleanBefore,
    "new publish must not modify the source",
  );

  const softDir = join(directory, "soft");
  await (await import("node:fs/promises")).mkdir(softDir);
  await writeFile(join(softDir, "index.html"), '<!doctype html><script src="/main.js"></script>');
  const soft = await preflight({ publishDir: softDir, targetHtml: "index.html" });
  assert(soft.status === "confirmation_required", "root absolute path must require confirmation");
  const softPublished = await publishDemo({
    action: "create",
    demoUrl,
    displayName: "Phase 6 soft risk",
    mcpUrl: appUrl + "/mcp",
    publishDir: softDir,
    riskAckDigest: soft.riskAckDigest,
    targetHtml: "index.html",
    token,
    uploadHostOverride: "127.0.0.1",
  });

  const hardDir = join(directory, "hard");
  await (await import("node:fs/promises")).mkdir(hardDir);
  await writeFile(join(hardDir, ".env"), "NEVER_UPLOAD=1");
  await writeFile(join(hardDir, "index.html"), "<h1>blocked</h1>");
  const hardBefore = await digestDirectory(hardDir);
  const hard = await preflight({ publishDir: hardDir, targetHtml: "index.html" });
  assert(hard.status === "blocked", "sensitive file must hard block");
  assert(
    hard.blocks.some((entry) => entry.id === "SENSITIVE_FILE"),
    "hard block must identify sensitive file",
  );
  assert((await digestDirectory(hardDir)) === hardBefore, "hard block must not modify the source");

  await writeFile(join(cleanDir, "index.html"), "<!doctype html><h1>version two</h1>");
  const replaced = await publishDemo({
    action: "replace",
    demoUrl,
    displayName: "Phase 6 replaced",
    mcpUrl: appUrl + "/mcp",
    projectId: first.shareUrl,
    publishDir: cleanDir,
    targetHtml: "index.html",
    token,
    uploadHostOverride: "127.0.0.1",
  });
  assert(replaced.projectId === first.projectId, "replace must retain the project id");
  assert(replaced.shareUrl === first.shareUrl, "replace must retain the exact target link");

  const cookie = await createDemoSession("/" + first.projectId + "/index.html");
  const content = await request(first.shareUrl, { headers: { cookie } });
  assert(content.status === 200, "published target link must be available to an authorized member");
  assert(
    (await content.text()).includes("version two"),
    "replace must atomically serve new content",
  );
  const elapsedMs = Math.round(performance.now() - startedAt);
  assert(elapsedMs <= 60_000, "clean publish workflow must stay within 60 seconds");
  console.log(
    JSON.stringify({
      elapsedMs,
      first: first.shareUrl,
      replaced: replaced.shareUrl,
      softRisk: softPublished.shareUrl,
      status: "phase6-skill-ok",
    }),
  );
} finally {
  await rm(directory, { force: true, recursive: true });
}

async function assertPackages() {
  const checks = [
    ["skills/html-share/dist/codex-html-share.zip", ".codex/skills/html-share/SKILL.md"],
    ["skills/html-share/dist/claude-code-html-share.zip", ".claude/skills/html-share/SKILL.md"],
  ];
  for (const [archive, requiredPath] of checks) {
    const result = await execute("unzip", ["-Z1", archive]);
    assert(
      result.stdout.split("\n").includes(requiredPath),
      archive + " must install the expected Skill path",
    );
  }
}

async function createToken() {
  const login = await request(appUrl + "/auth/login?return_path=/tokens");
  const completed = await request(requiredHeader(login, "location"));
  const token = await request(appUrl + "/api/tokens", {
    body: JSON.stringify({ name: "Phase 6 smoke" }),
    headers: {
      cookie: requiredHeader(completed, "set-cookie").split(";", 1)[0],
      "content-type": "application/json",
      origin: appWebUrl,
    },
    method: "POST",
  });
  assert(token.status === 201, "token creation must succeed");
  return (await token.json()).value;
}

async function createDemoSession(returnPath) {
  const login = await request(
    demoUrl + "/auth/content-login?return_path=" + encodeURIComponent(returnPath),
  );
  assert(login.status === 200, "content authorization must load");
  const page = await login.text();
  const state = page.match(/"state":"([A-Za-z0-9_-]+)"/)?.[1];
  assert(typeof state === "string", "content authorization state must exist");
  const completed = await request(demoUrl + "/auth/internal/complete", {
    body: new URLSearchParams({ code: "simulator-member", state }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", origin: demoUrl },
    method: "POST",
  });
  assert(completed.status === 302, "content authorization must complete");
  return requiredHeader(completed, "set-cookie").split(";", 1)[0];
}

function request(url, init = {}) {
  return fetch(url, { ...init, redirect: "manual" });
}

async function digestDirectory(directory) {
  const checked = await preflight({ publishDir: directory, targetHtml: "index.html" });
  return createHash("sha256").update(JSON.stringify(checked.files)).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requiredHeader(response, name) {
  const value = response.headers.get(name);
  if (value === null) throw new Error(name + " header missing");
  return value;
}
