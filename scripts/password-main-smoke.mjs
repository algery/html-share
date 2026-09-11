import { randomBytes } from "node:crypto";
import { createHarness, fixture, isolatedConfiguration } from "./password-smoke-support.mjs";
import { mainEnvironment, mainProcesses, eventually } from "./password-main-processes.mjs";

import { verifyMainPassword } from "./password-main-authorization.mjs";
import { completeMainSmoke } from "./password-main-log-audit.mjs";

let assertions = 0;
let assertionFailure;
const check = (condition, message) => {
  assertions++;
  if (!condition) {
    assertionFailure = message;
    throw new Error(message);
  }
};
const processes = mainProcesses();
const secrets = [];
let h;
let report;
let stage = "setup";
let failed = false;
let restoreSweep;
try {
  const config = isolatedConfiguration();
  h = await createHarness(config, check);
  stage = "isolation-precondition";
  // main.js runs global queues. Refuse a database containing another fixture or user's project.
  check(
    (await h.prisma.demoProject.count({ where: { tenantId: { not: h.tenantId } } })) === 0,
    "isolated database contains no unrelated projects",
  );
  check(
    (await h.prisma.cleanupJob.count({ where: { status: { not: "COMPLETED" } } })) === 0,
    "isolated database has no unrelated cleanup queues",
  );
  const sweep = await h.prisma.objectSweepState.findUnique({ where: { id: "projects" } });
  restoreSweep = async () => {
    if (sweep)
      await h.prisma.objectSweepState.upsert({
        where: { id: sweep.id },
        create: sweep,
        update: sweep,
      });
    else await h.prisma.objectSweepState.deleteMany({ where: { id: "projects" } });
  };
  stage = "runtime-environment";
  const env = await mainEnvironment(config, h);
  env.AUTH_STATE_SECRET = randomBytes(32).toString("base64");
  env.MCP_TOKEN_HASH_SECRET = randomBytes(32).toString("base64");
  secrets.push(
    h.mcpToken,
    env.PASSWORD_RESULT_ENCRYPTION_KEY,
    env.PASSWORD_MANAGEMENT_ENCRYPTION_KEY,
    env.AUTH_STATE_SECRET,
    env.MCP_TOKEN_HASH_SECRET,
  );
  check(new Set(secrets).size === secrets.length, "runtime secrets are independent");
  check(
    env.PASSWORD_RESULT_ENCRYPTION_KEY !== "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
    "runtime encryption key replaces example key",
  );
  check(
    env.PASSWORD_MANAGEMENT_ENCRYPTION_KEY !== "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
    "runtime management encryption key replaces example key",
  );

  stage = "queue-publication";
  const input = fixture(13, { access_mode: "password" });
  const prepared = await h.call("prepare_demo_upload", input.args);
  for (const upload of prepared.uploads) {
    const url = new URL(upload.upload_url);
    check(
      url.origin === config.endpoint && url.pathname.startsWith(`/${h.bucket}/`),
      "direct upload targets owned isolated bucket",
    );
    const response = await fetch(url, {
      method: "PUT",
      headers: upload.upload_headers,
      body: input.bodies.get(upload.relative_path),
      signal: AbortSignal.timeout(10000),
    });
    check(response.ok, "isolated private PUT succeeds");
    await response.arrayBuffer();
  }
  const queued = await h.call("complete_demo_upload", { upload_id: prepared.upload_id });
  check(
    queued.status === "processing" && !queued.access_password,
    "MCP queues password publication without finalizing",
  );

  stage = "main-startup";
  processes.start("server", env);
  const workerEnv = { ...env };
  delete workerEnv.PASSWORD_MANAGEMENT_ENCRYPTION_KEY;
  delete workerEnv.PASSWORD_RESULT_ENCRYPTION_KEY;
  check(
    !("PASSWORD_MANAGEMENT_ENCRYPTION_KEY" in workerEnv) &&
      !("PASSWORD_RESULT_ENCRYPTION_KEY" in workerEnv),
    "worker main receives no password encryption keys",
  );
  processes.start("worker", workerEnv);
  for (const port of [55101, 55102]) {
    await eventually(
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health/live`, {
            headers: {
              "x-forwarded-host": "app.localhost",
              authorization: `Bearer ${h.mcpToken}`,
            },
            signal: AbortSignal.timeout(1000),
          });
          return response.ok && (await response.json()).status === "ok";
        } catch {
          return false;
        }
      },
      "real main health is ready",
      check,
      processes,
    );
  }

  stage = "real-main-publication";
  await eventually(
    async () => {
      const task = await h.prisma.uploadTask.findUniqueOrThrow({
        where: { id: prepared.upload_id },
      });
      if (task.status === "FAILED") throw new Error("main worker failed publication");
      return task.status === "COMPLETED";
    },
    "main worker publishes queued task",
    check,
    processes,
  );
  const published = await h.call("get_demo_upload_status", { upload_id: prepared.upload_id });
  check(
    published.status === "completed" &&
      published.password_status === "generated" &&
      /^[A-Za-z0-9]{8}$/.test(published.access_password),
    "MCP observes generated password from main publication",
  );
  secrets.push(published.access_password);
  const project = await h.prisma.demoProject.findUniqueOrThrow({
    where: { projectKey: published.project_id },
  });
  check(
    project.accessMode === "password" &&
      project.encryptedPassword !== null &&
      !project.encryptedPassword.includes(published.access_password) &&
      (await h.crypto.verify(published.access_password, project.passwordHash)),
    "real worker atomically publishes verifiable and recoverable password mode",
  );
  secrets.push(project.encryptedPassword);

  const managedDetail = await fetch(`http://127.0.0.1:55101/api/projects/${published.project_id}`, {
    headers: {
      cookie: h.appCookie,
      "x-forwarded-host": "app.localhost",
      "x-forwarded-proto": "https",
    },
    signal: AbortSignal.timeout(10000),
  });
  const managedBody = await managedDetail.json();
  check(
    managedDetail.status === 200 &&
      managedDetail.headers.get("cache-control") === "private, no-store" &&
      managedBody.project.accessPassword === published.access_password &&
      managedBody.project.passwordStatus === "available",
    "real server main decrypts the current password only for the owner detail",
  );

  stage = "real-server-verification";
  await verifyMainPassword({ published, project, env, h, secrets, check });

  stage = "real-main-cleanup";
  const expiresAt = new Date(Date.now() - 60000);
  await h.prisma.$transaction([
    h.prisma.uploadTask.update({
      where: { id: published.upload_id },
      data: {
        createdAt: new Date(expiresAt.getTime() - 24 * 60 * 60 * 1000),
        passwordResultExpiresAt: expiresAt,
      },
    }),
    h.prisma.passwordAccessGrant.updateMany({
      where: { projectId: project.id },
      data: { expiresAt },
    }),
  ]);
  await eventually(
    async () => {
      const task = await h.prisma.uploadTask.findUniqueOrThrow({
        where: { id: published.upload_id },
      });
      return (
        task.encryptedPasswordResult === null &&
        task.pendingPasswordHash === null &&
        task.passwordResultExpiresAt === null &&
        (await h.prisma.passwordAccessGrant.count({ where: { projectId: project.id } })) === 0
      );
    },
    "main worker clears expired encrypted result and real grant",
    check,
    processes,
  );
  const expired = await h.call("get_demo_upload_status", { upload_id: published.upload_id });
  check(
    expired.password_status === "unavailable" && !expired.access_password,
    "cleaned history cannot return password",
  );
  const metrics = await (
    await fetch("http://127.0.0.1:55102/health/metrics", { signal: AbortSignal.timeout(10000) })
  ).json();
  check(
    metrics.metrics["worker.upload_finalization.status.published"]?.count === 1,
    "main telemetry records one published upload",
  );
  check(
    metrics.metrics["worker.password_cleanup.status.completed"]?.count >= 1,
    "main telemetry records completed password cleanup",
  );
  check(
    metrics.objectStorage.getObjectCalls === 0 && metrics.objectStorage.bodyBytesRead === 0,
    "real worker publication and cleanup never GET object bodies",
  );
  const publication = h.publicationMetrics().server;
  check(
    publication.getObjectCalls === 0 && publication.bodyBytesRead === 0,
    "MCP publication server never GETs object bodies",
  );
  report = {
    status: "password-main-smoke-ok",
    serverMainHealthy: true,
    workerMainHealthy: true,
    runtimeIndependentKeyInjection: true,
    realWorkerPublished: true,
    realServerManagedPasswordRead: true,
    realServerPasswordVerified: true,
    expiredCipherAndGrantCleaned: true,
    objectStorage: metrics.objectStorage,
  };
} catch {
  failed = true;
} finally {
  await processes.stop();
  try {
    try {
      if (restoreSweep) await restoreSweep();
    } finally {
      if (h) await h.cleanup();
    }
  } catch {
    failed = true;
    stage = "fixture-cleanup";
  }
}
if (failed) {
  console.error(
    JSON.stringify({
      status: "password-main-smoke-failed",
      stage,
      assertionFailure,
      capturedOutputWithheld: true,
    }),
  );
  process.exitCode = 1;
} else {
  try {
    await completeMainSmoke({
      assertions: () => assertions,
      check,
      logs: processes.logs(),
      report,
      secrets,
    });
  } catch {
    console.error(
      JSON.stringify({
        status: "password-main-smoke-failed",
        stage: "safe-log-audit",
        assertionFailure,
        capturedOutputWithheld: true,
      }),
    );
    process.exitCode = 1;
  }
}
