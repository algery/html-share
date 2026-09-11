import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflight } from "../skills/html-share/scripts/preflight.mjs";
import { publishDemo } from "../skills/html-share/scripts/upload.mjs";
import { createHarness, isolatedConfiguration } from "./password-smoke-support.mjs";
import { startPasswordHttps } from "./password-https-harness.mjs";
import { responseCookies, responseState } from "./password-access-fixture.mjs";

let assertions = 0;
let lastCheck = "isolated setup";
function check(condition, message) {
  assertions++;
  lastCheck = message;
  if (!condition) throw new Error(message);
}
const config = isolatedConfiguration();
const directory = await mkdtemp(join(tmpdir(), "html-share-risk-smoke-"));
let h;
let https;
const counts = { requests: 0, prepare: 0, puts: 0, blocked: 0, published: 0 };
try {
  h = await createHarness(config, check, {
    passwordAccess: true,
    demoUrl: "https://localhost:55443",
  });
  https = await startPasswordHttps();
  const source = join(directory, "source");
  await mkdir(join(source, "assets"), { recursive: true });
  const html = '<!doctype html><script src="/assets/app.js"></script><h1>Risk fixture</h1>';
  await writeFile(join(source, "index.html"), html);
  await writeFile(join(source, "assets/app.js"), "/* original */");
  const input = {
    action: "create",
    accessMode: "password",
    publishDir: source,
    targetHtml: "index.html",
    displayName: "Isolated risk confirmation",
    mcpUrl: h.mcpUrl,
    demoUrl: h.demoUrl,
    token: h.mcpToken,
  };
  let expectedDigest;
  const dependencies = {
    request: async (url, init) => {
      counts.requests++;
      if (init.method === "PUT") counts.puts++;
      else {
        const body = JSON.parse(init.body);
        if (body.params?.name === "prepare_demo_upload") {
          counts.prepare++;
          check(
            body.params.arguments.risk_ack_digest === expectedDigest,
            "prepare uses current confirmed risk digest",
          );
          check(
            body.params.arguments.access_mode === "password",
            "explicit password reaches real MCP",
          );
        }
      }
      return fetch(url, init);
    },
    sleep: async () => {
      await h.finalize();
    },
  };
  async function blocked(overrides, expectedMessage) {
    const path = overrides.publishDir ?? source;
    const before = await snapshot(path);
    const requestsBefore = counts.requests;
    let failure;
    try {
      await publishDemo({ ...input, ...overrides }, dependencies);
    } catch (error) {
      failure = error.message;
    }
    check(
      typeof failure === "string" && failure.includes(expectedMessage),
      "publication rejects expected risk gate",
    );
    check(counts.requests === requestsBefore, "blocked publication makes zero network requests");
    check(
      (await snapshot(path)) === before,
      "blocked publication preserves every source entry and byte",
    );
    counts.blocked++;
  }
  const initial = await preflight(input);
  check(
    initial.status === "confirmation_required",
    "root absolute reference requires confirmation",
  );
  check(
    initial.risks.some((risk) => risk.id === "ROOT_ABSOLUTE_PATH"),
    "warning identifies root absolute reference",
  );
  await blocked({}, "风险确认摘要不匹配");
  await blocked({ riskAckDigest: "wrong-digest" }, "风险确认摘要不匹配");
  await writeFile(join(source, "assets/app.js"), "/* modified */");
  await blocked({ riskAckDigest: initial.riskAckDigest }, "风险确认摘要不匹配");
  for (const kind of ["sensitive", "escape"]) {
    const hard = join(directory, kind);
    await mkdir(hard);
    await writeFile(join(hard, "index.html"), html);
    if (kind === "sensitive") await writeFile(join(hard, ".env"), "DUMMY_FIXTURE=1");
    else await symlink(join(source, "index.html"), join(hard, "outside.html"));
    const inspection = await preflight({ ...input, publishDir: hard });
    check(
      inspection.blocks.some(
        (entry) => entry.id === (kind === "sensitive" ? "SENSITIVE_FILE" : "PATH_ESCAPE"),
      ),
      "hard risk is identified",
    );
    await blocked(
      {
        publishDir: hard,
        riskAckDigest: inspection.riskAckDigest,
        force: true,
        skipPreflight: true,
      },
      "硬阻断",
    );
  }
  check(
    (await h.prisma.uploadTask.count({ where: { tenantId: h.tenantId } })) === 0,
    "blocked attempts create no database upload task",
  );
  const confirmed = await preflight(input);
  expectedDigest = confirmed.riskAckDigest;
  check(
    expectedDigest !== initial.riskAckDigest,
    "changed directory requires a fresh confirmation",
  );
  const before = await snapshot(source);
  const result = await publishDemo({ ...input, riskAckDigest: expectedDigest }, dependencies);
  counts.published++;
  check(
    result.accessMode === "password" && result.passwordStatus === "generated",
    "confirmed risk completes password publication",
  );
  check(typeof result.accessPassword === "string", "real completed publication returns a password");
  check(!result.shareUrl.includes(result.accessPassword), "password is absent from share URL");
  check(
    counts.prepare === 1 && counts.puts === 2,
    "only confirmed attempt prepares and uploads all original files",
  );
  const path = new URL(result.shareUrl).pathname;
  const entry = await https.request(path);
  check(
    entry.status === 302 && entry.headers.location.startsWith("/auth/password"),
    "real share link is password protected",
  );
  const page = await https.request(entry.headers.location);
  const verified = await https.request("/auth/password/verify", {
    method: "POST",
    headers: {
      cookie: responseCookies(page),
      origin: h.demoUrl,
      "content-type": "application/json",
    },
    body: JSON.stringify({ state: responseState(page), password: result.accessPassword }),
  });
  check(verified.status === 200, "published password grants access through HTTPS");
  for (const relative of ["index.html", "assets/app.js"]) {
    const content = await https.request(`/${result.projectId}/${relative}`, {
      headers: { cookie: responseCookies(verified) },
    });
    check(
      content.status === 200 && content.body.equals(await readFile(join(source, relative))),
      "published file bytes equal unchanged original source",
    );
  }
  check(
    (await snapshot(source)) === before,
    "complete publication leaves directory names, metadata, and bytes unchanged",
  );
  const metrics = h.publicationMetrics();
  check(
    metrics.worker.getObjectCalls === 0 && metrics.worker.bodyBytesRead === 0,
    "finalizer reads no object bodies",
  );
  console.log(
    JSON.stringify({
      status: "password-skill-risk-smoke-ok",
      assertions,
      counts,
      sourceUnchanged: true,
      realMcp: true,
      realMinio: true,
      realHttps: true,
      worker: metrics.worker,
    }),
  );
} catch (error) {
  // Third-party errors can include signed URLs or request bodies; output only safe diagnostics.
  console.error(
    JSON.stringify({
      status: "password-skill-risk-smoke-failed",
      assertions,
      counts,
      lastCheck,
      errorType: error instanceof Error ? error.name : "unknown",
    }),
  );
  process.exitCode = 1;
} finally {
  try {
    if (https) await https.close();
  } finally {
    try {
      if (h) await h.cleanup();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function snapshot(directory) {
  const entries = [];
  async function visit(path = "") {
    const absolute = join(directory, path);
    const details = await lstat(absolute);
    entries.push({
      path,
      mode: details.mode,
      mtime: details.mtimeMs,
      ctime: details.ctimeMs,
      content: details.isSymbolicLink()
        ? await readlink(absolute)
        : details.isFile()
          ? createHash("sha256")
              .update(await readFile(absolute))
              .digest("hex")
          : null,
    });
    if (details.isDirectory())
      for (const name of (await readdir(absolute)).sort()) await visit(join(path, name));
  }
  await visit();
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
