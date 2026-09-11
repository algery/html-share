import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createHarness, isolatedConfiguration } from "./password-smoke-support.mjs";
import { startPasswordHttps } from "./password-https-harness.mjs";
import {
  publishAccessFixture,
  responseCookies,
  responseState,
} from "./password-access-fixture.mjs";
import {
  createPasswordCleanupRepository,
  createProjectDeletionRepository,
} from "../packages/db/dist/index.js";
import { runPasswordAccessCleanup } from "../apps/worker/dist/jobs/cleanup-password-access.js";

assert(
  typeof process.send === "function",
  "run through password-security-smoke.mjs to capture logger output safely",
);
let assertions = 0;
const check = (condition, message) => {
  assert(condition, message);
  assertions++;
};
const credentials = ["Wrng2345", "Protected fixture"];
const projectCiphertexts = [];
const h = await createHarness(isolatedConfiguration(), check, {
  passwordAccess: true,
  logger: true,
  demoUrl: "https://localhost:55443",
});
let https;
let report;
try {
  credentials.push(
    h.mcpToken,
    process.env.PASSWORD_RESULT_ENCRYPTION_KEY,
    process.env.PASSWORD_MANAGEMENT_ENCRYPTION_KEY,
  );
  https = await startPasswordHttps();
  const first = await publishAccessFixture(h, check);
  const second = await publishAccessFixture(h, check);
  credentials.push(first.result.access_password, second.result.access_password);
  const firstCookie = await authorize(first);
  const secondCookie = await authorize(second);
  await checkDatabasePlaintext();
  const firstProject = await h.prisma.demoProject.findUniqueOrThrow({
    where: { projectKey: first.result.project_id },
  });
  const secondProject = await h.prisma.demoProject.findUniqueOrThrow({
    where: { projectKey: second.result.project_id },
  });
  projectCiphertexts.push(
    ...[firstProject.encryptedPassword, secondProject.encryptedPassword].filter(Boolean),
  );
  credentials.push(...projectCiphertexts);
  const expiresAt = new Date(Date.now() - 60000);
  await h.prisma.uploadTask.update({
    where: { id: first.result.upload_id },
    data: { passwordResultExpiresAt: expiresAt },
  });
  const expired = await h.call("get_demo_upload_status", { upload_id: first.result.upload_id });
  check(
    expired.password_status === "unavailable" && expired.access_password === undefined,
    "expired encrypted result is immediately unavailable before cleanup",
  );
  const retainedCipher = await h.prisma.uploadTask.findUniqueOrThrow({
    where: { id: first.result.upload_id },
  });
  check(
    retainedCipher.encryptedPasswordResult !== null,
    "expiry denial does not depend on cleanup having run",
  );
  await h.prisma.passwordAccessGrant.updateMany({
    where: { projectId: firstProject.id },
    data: { expiresAt },
  });
  await h.prisma.passwordAccessGrant.createMany({
    data: Array.from({ length: 120 }, () => ({
      id: randomUUID(),
      tenantId: h.tenantId,
      projectId: firstProject.id,
      passwordVersion: firstProject.passwordVersion,
      grantHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
      expiresAt,
    })),
  });
  const rejected = await https.request(first.targetPath, {
    headers: { cookie: firstCookie, "if-none-match": "*" },
    method: "HEAD",
  });
  check(
    rejected.status === 302 && rejected.headers.etag === undefined,
    "expired grant denies conditional HEAD before cleanup",
  );
  const cleanup = createPasswordCleanupRepository(h.prisma);
  check(
    (await runPasswordAccessCleanup({ repository: cleanup })) === "completed",
    "real worker cleanup starts expired batch",
  );
  check(
    (await h.prisma.passwordAccessGrant.count({ where: { projectId: firstProject.id } })) === 21,
    "one cleanup cycle removes at most 100 grants",
  );
  check(
    (await runPasswordAccessCleanup({ repository: cleanup })) === "completed",
    "second cleanup batch completes remainder",
  );
  check(
    (await runPasswordAccessCleanup({ repository: cleanup })) === "idle",
    "cleanup returns idle after draining",
  );
  const cleared = await h.prisma.uploadTask.findUniqueOrThrow({
    where: { id: first.result.upload_id },
  });
  check(
    cleared.encryptedPasswordResult === null &&
      cleared.passwordResultExpiresAt === null &&
      cleared.pendingPasswordHash === null,
    "expired task password material cleared",
  );
  check(
    (await h.prisma.passwordAccessGrant.count({ where: { projectId: secondProject.id } })) === 1,
    "valid other-project grant survives cleanup",
  );
  check(
    (await https.request(second.targetPath, { headers: { cookie: secondCookie } })).status === 200,
    "unexpired grant still reads content",
  );
  check(
    (await h.call("get_demo_upload_status", { upload_id: second.result.upload_id }))
      .access_password === second.result.access_password,
    "valid result remains available",
  );
  await createProjectDeletionRepository(h.prisma).deleteAsOwner({
    ownerUserId: secondProject.ownerUserId,
    projectKey: secondProject.projectKey,
    now: new Date(),
  });
  const deleted = await https.request(second.targetPath, { headers: { cookie: secondCookie } });
  check(deleted.status === 404, "owner deletion immediately blocks previous grant");
  const deletedStatus = await h.call("get_demo_upload_status", {
    upload_id: second.result.upload_id,
  });
  check(
    deletedStatus.access_password === undefined && deletedStatus.password_status === "unavailable",
    "deleted project never returns old password",
  );
  await checkDatabasePlaintext();
  const workerMetrics = h.publicationMetrics().worker;
  check(
    workerMetrics.getObjectCalls === 0 && workerMetrics.bodyBytesRead === 0,
    "security lifecycle preserves zero-body publication",
  );
  report = {
    status: "password-security-smoke-ok",
    assertions,
    cleanupBatch: 100,
    expiredGrantsCleaned: 121,
    realServerProductionLogger: true,
    worker: workerMetrics,
  };

  async function checkDatabasePlaintext() {
    const data = JSON.stringify(
      {
        tasks: await h.prisma.uploadTask.findMany({ where: { tenantId: h.tenantId } }),
        projects: await h.prisma.demoProject.findMany({ where: { tenantId: h.tenantId } }),
        grants: await h.prisma.passwordAccessGrant.findMany({ where: { tenantId: h.tenantId } }),
      },
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    );
    check(
      credentials
        .filter((value) => !projectCiphertexts.includes(value))
        .every((value) => !data.includes(value)),
      "database stores no plaintext runtime credential before or after cleanup",
    );
  }

  async function authorize(published) {
    const page = await https.request(
      `/auth/password?return_path=${encodeURIComponent(published.targetPath)}`,
    );
    const state = responseState(page);
    const cookie = responseCookies(page);
    credentials.push(state, cookie.split("=", 2)[1]);
    const denied = await https.request("/auth/password/verify", {
      method: "POST",
      headers: { origin: h.demoUrl, cookie, "content-type": "application/json" },
      body: JSON.stringify({
        state,
        password: "Wrng2345",
        extra_password: published.result.access_password,
      }),
    });
    check(
      denied.status === 401 && !denied.body.includes(published.result.access_password),
      "wrong-password response never echoes password fields",
    );
    const malformed = await https.request("/auth/password/verify", {
      method: "POST",
      headers: { origin: h.demoUrl, cookie, "content-type": "application/json" },
      body: `{"password":"${published.result.access_password}"`,
    });
    check(
      malformed.status === 400 && !malformed.body.includes(published.result.access_password),
      "parser error is generic and does not echo password",
    );
    const granted = await https.request("/auth/password/verify", {
      method: "POST",
      headers: { origin: h.demoUrl, cookie, "content-type": "application/json" },
      body: JSON.stringify({ state, password: published.result.access_password }),
    });
    check(granted.status === 200, "security fixture real password verification succeeds");
    const grant = responseCookies(granted);
    credentials.push(grant.split("=", 2)[1]);
    return grant;
  }
} finally {
  try {
    if (https) await https.close();
  } finally {
    await h.cleanup();
  }
}
await new Promise((resolve, reject) =>
  process.send({ type: "credentials", values: credentials.filter(Boolean) }, (error) =>
    error ? reject(error) : resolve(),
  ),
);
await new Promise((resolve, reject) =>
  process.send({ type: "report", value: report }, (error) => (error ? reject(error) : resolve())),
);
process.disconnect();
