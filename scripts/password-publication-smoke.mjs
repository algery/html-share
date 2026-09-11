import { randomUUID } from "node:crypto";
import { createHarness, fixture, isolatedConfiguration } from "./password-smoke-support.mjs";

let assertions = 0;
function check(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(`assertion ${assertions}: ${message}`);
}
const config = isolatedConfiguration();
const harness = await createHarness(config, check);
const { call, prisma } = harness;
const status = (upload_id) => call("get_demo_upload_status", { upload_id });
const complete = (upload_id) => call("complete_demo_upload", { upload_id });
const project = (projectKey) => prisma.demoProject.findUniqueOrThrow({ where: { projectKey } });
const startedAt = Date.now();
try {
  const defaultFixture = fixture(1);
  const ordinary = await publish(defaultFixture);
  check(ordinary.access_mode === "organization", "omitted mode creates organization project");
  check(!("access_password" in ordinary), "default result has no password");

  const passwordFixture = fixture(2, { access_mode: "password" });
  const first = await publish(passwordFixture);
  check(
    first.password_status === "generated" && /^[A-Za-z0-9]{8}$/.test(first.access_password),
    "password creation returns generated password",
  );
  const firstProject = await project(first.project_id);
  check(
    await harness.crypto.verify(first.access_password, firstProject.passwordHash),
    "generated password verifies stored scrypt hash",
  );
  const storedTask = await prisma.uploadTask.findUniqueOrThrow({ where: { id: first.upload_id } });
  check(
    !JSON.stringify(storedTask, (_, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ).includes(first.access_password),
    "database task does not store plaintext password",
  );
  check(
    (await complete(first.upload_id)).access_password === first.access_password,
    "same completed task returns identical password",
  );
  const repeated = await call("prepare_demo_upload", passwordFixture.args);
  check(
    repeated.upload_id === first.upload_id && repeated.idempotent === true && !repeated.uploads,
    "same prepare task remains idempotent without new PUTs",
  );
  await call(
    "prepare_demo_upload",
    { ...passwordFixture.args, access_mode: "organization" },
    "invalid_upload_input",
  );
  await call(
    "prepare_demo_upload",
    { ...passwordFixture.args, regenerate_password: true },
    "invalid_upload_input",
  );
  await call(
    "get_demo_upload_status",
    { upload_id: first.upload_id },
    "upload_not_found",
    await harness.otherClient(),
  );

  for (const options of [{}, { access_mode: "password" }]) {
    const inherited = await publish(
      fixture(3, { action: "replace", project_id: first.project_id, ...options }),
    );
    check(
      inherited.access_mode === "password" && inherited.password_status === "retained",
      "overwrite inherits password mode",
    );
    check(
      !("access_password" in inherited) && inherited.password_message === "沿用原密码",
      "retained result explicitly explains original password",
    );
    const current = await project(first.project_id);
    check(
      current.passwordHash === firstProject.passwordHash &&
        current.passwordVersion === firstProject.passwordVersion,
      "inherit and repeated enable preserve hash and version",
    );
  }

  const grant = await prisma.passwordAccessGrant.create({
    data: {
      tenantId: harness.tenantId,
      projectId: firstProject.id,
      passwordVersion: firstProject.passwordVersion,
      grantHash: randomUUID(),
      expiresAt: new Date(Date.now() + 28_800_000),
    },
  });
  const reset = await publish(
    fixture(4, { action: "replace", project_id: first.project_id, regenerate_password: true }),
  );
  check(
    reset.password_status === "generated" && reset.access_password !== first.access_password,
    "explicit reset generates new password",
  );
  check(
    (await complete(reset.upload_id)).access_password === reset.access_password,
    "reset retry returns the same generated password",
  );
  const resetProject = await project(first.project_id);
  check(
    resetProject.passwordVersion === firstProject.passwordVersion + 1,
    "reset increments password version",
  );
  check(
    (await prisma.passwordAccessGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAt !==
      null,
    "reset revokes old grant",
  );
  const old = await status(first.upload_id);
  check(
    old.password_status === "unavailable" && !old.access_password,
    "reset makes original task result unavailable",
  );

  const failedFixture = fixture(5, {
    action: "replace",
    project_id: first.project_id,
    regenerate_password: true,
  });
  const failed = await prepare(failedFixture);
  await putFiles(failed, failedFixture, 1);
  const pending = await complete(failed.upload_id);
  check(
    pending.status === "processing" && !pending.access_password,
    "processing reset cannot disclose password",
  );
  check(
    (await harness.finalize()) === "failed",
    "missing direct-upload object fails real Worker finalization",
  );
  const failedStatus = await status(failed.upload_id);
  check(
    failedStatus.status === "failed" && !failedStatus.access_password,
    "failed task never returns password",
  );
  const afterFailure = await project(first.project_id);
  check(
    afterFailure.currentRevisionId === resetProject.currentRevisionId &&
      afterFailure.accessMode === resetProject.accessMode &&
      afterFailure.passwordHash === resetProject.passwordHash &&
      afterFailure.passwordVersion === resetProject.passwordVersion,
    "failed reset atomically preserves old content and password",
  );
  await harness.read(reset, fixture(4).bodies);
  check(
    (await status(reset.upload_id)).access_password === reset.access_password,
    "failed reset leaves previous result retrievable",
  );

  const disabled = await publish(
    fixture(6, { action: "replace", project_id: first.project_id, access_mode: "organization" }),
  );
  check(
    disabled.access_mode === "organization" && !disabled.access_password,
    "disable returns organization mode without password",
  );
  const disabledProject = await project(first.project_id);
  check(
    disabledProject.passwordHash === null &&
      disabledProject.passwordVersion === resetProject.passwordVersion + 1,
    "disable clears hash and advances version",
  );
  const unavailable = await status(reset.upload_id);
  check(
    unavailable.password_status === "unavailable" && !unavailable.access_password,
    "disabled old task cannot reveal password",
  );
  const reenabled = await publish(
    fixture(7, { action: "replace", project_id: first.project_id, access_mode: "password" }),
  );
  check(
    reenabled.password_status === "generated",
    "organization to password transition generates a password",
  );

  const metrics = harness.publicationMetrics();
  check(
    metrics.server.getObjectCalls === 0 &&
      metrics.server.bodyBytesRead === 0 &&
      metrics.worker.getObjectCalls === 0 &&
      metrics.worker.bodyBytesRead === 0,
    "publication never reads object bodies on Server or Worker",
  );
  check(
    metrics.content.getObjectCalls > 0 && metrics.content.bodyBytesRead > 0,
    "authorized content reads are measured separately",
  );
  console.log(
    JSON.stringify({
      status: "phase10-password-publication-ok",
      assertions,
      elapsedMs: Date.now() - startedAt,
      objectStorage: metrics,
      trace: harness.trace,
    }),
  );
} finally {
  await harness.cleanup();
}

async function prepare(input) {
  const result = await call("prepare_demo_upload", input.args);
  check(
    result.status === "prepared" && result.uploads.length === input.args.files.length,
    "prepare returns exact per-file PUT contracts",
  );
  check(!result.access_password, "prepared tasks never expose pending passwords");
  for (const upload of result.uploads) {
    const file = input.args.files.find((file) => file.relative_path === upload.relative_path);
    check(
      file &&
        upload.upload_headers["content-md5"] === file.content_md5 &&
        upload.upload_headers["content-length"] === String(file.size) &&
        upload.upload_headers["content-type"] === file.mime_type,
      "PUT headers bind exact declared metadata",
    );
    const url = new URL(upload.upload_url);
    check(
      url.origin === config.endpoint && url.pathname.startsWith(`/${harness.bucket}/`),
      "signed PUT stays in isolated private bucket",
    );
    check(
      Number(url.searchParams.get("X-Amz-Expires")) <= 300,
      "signed PUT lifetime remains five minutes",
    );
  }
  const before = await status(result.upload_id);
  check(
    before.status === "prepared" && !before.access_password,
    "prepared status never reveals password",
  );
  return result;
}

async function putFiles(prepared, input, limit = prepared.uploads.length) {
  for (const upload of prepared.uploads.slice(0, limit)) {
    const response = await fetch(upload.upload_url, {
      method: "PUT",
      headers: upload.upload_headers,
      body: input.bodies.get(upload.relative_path),
      signal: AbortSignal.timeout(10_000),
    });
    check(response.status === 200, "direct private MinIO PUT succeeds");
    const unsigned = new URL(upload.upload_url);
    unsigned.search = "";
    const denied = await fetch(unsigned, { signal: AbortSignal.timeout(10_000) });
    check(denied.status === 403, "unsigned private object read is forbidden");
    await denied.arrayBuffer();
  }
}

async function publish(input) {
  const prepared = await prepare(input);
  await putFiles(prepared, input);
  const before = await project(prepared.project_id);
  const submitted = await complete(prepared.upload_id);
  check(
    submitted.status === "processing" && !submitted.access_password,
    "complete queues processing without disclosing pending password",
  );
  const stillPending = await project(prepared.project_id);
  check(
    stillPending.currentRevisionId === before.currentRevisionId &&
      stillPending.passwordHash === before.passwordHash &&
      stillPending.accessMode === before.accessMode,
    "complete alone does not switch content or access settings",
  );
  check(
    (await harness.finalize()) === "published",
    "real Worker validates HEAD metadata and commits publication",
  );
  const result = await status(prepared.upload_id);
  check(result.status === "completed", "official MCP client observes completed result");
  const prefix = `${harness.demoUrl}/${result.project_id}/`;
  check(
    result.project_url === prefix &&
      result.target_url ===
        prefix + input.args.target_html.split("/").map(encodeURIComponent).join("/"),
    "successful result contains exact encoded target and stable project URL",
  );
  check(
    !new URL(result.target_url).search && !new URL(result.target_url).hash,
    "sharing URL contains no password query or fragment",
  );
  await harness.read(result, input.bodies);
  return result;
}
