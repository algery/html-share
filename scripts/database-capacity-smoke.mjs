import { finalizeCapacityBatch } from "./database-capacity-publication.mjs";
import { capacityReport } from "./database-capacity-report.mjs";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createHarness, fixture, isolatedConfiguration } from "./password-smoke-support.mjs";
import {
  publishAccessFixture,
  responseCookies,
  responseState,
} from "./password-access-fixture.mjs";
import { startPasswordHttps } from "./password-https-harness.mjs";
import {
  backlog,
  observeTransactions,
  databaseSample,
  percentile,
  timedRead,
} from "./database-capacity-observer.mjs";
let assertions = 0;
const check = (condition, message) => {
  assert(condition, message);
  assertions++;
};
const config = isolatedConfiguration();
const provider = config.databaseProvider ?? "postgresql";
if (provider === "mysql") {
  const options = new URL(config.databaseUrl).searchParams;
  check(
    !["connectionLimit", "connection_limit"].some(
      (key) => options.has(key) && options.get(key) !== "5",
    ),
    "Both backends use an application pool of five",
  );
}
const h = await createHarness(config, check, {
  passwordAccess: true,
  productionReadiness: true,
  demoUrl: "https://localhost:55443",
  defaultRateLimits: true,
});
const transactionActivity = observeTransactions(h.prisma);
let https;
let sampling = true;
let sampler;
const samples = [];
const sampleErrors = [];
try {
  https = await startPasswordHttps();
  const initial = await databaseSample(h.prisma, provider);
  samples.push(initial);
  sampler = (async () => {
    while (sampling) {
      try {
        samples.push(await databaseSample(h.prisma, provider));
      } catch {
        sampleErrors.push("Database telemetry query failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();
  const published = await publishAccessFixture(h, check);
  const publisher = await h.otherClient();
  const uploads = await Promise.all(
    Array.from({ length: 10 }, async (_, index) => {
      const started = performance.now();
      const input = fixture(index, {
        access_mode: "password",
        display_name: `Phase26 capacity ${index}`,
      });
      const prepared = await h.call("prepare_demo_upload", input.args, undefined, publisher);
      check(
        prepared.status === "prepared",
        "Ten concurrent uploads prepare under default quotas/rate limits",
      );
      await Promise.all(
        prepared.uploads.map(async (upload) => {
          const response = await fetch(upload.upload_url, {
            method: "PUT",
            headers: upload.upload_headers,
            body: input.bodies.get(upload.relative_path),
            signal: AbortSignal.timeout(30_000),
          });
          check(response.ok, "Concurrent capacity object PUT succeeds");
        }),
      );
      const metadataStarted = performance.now();
      check(
        (
          await h.call(
            "complete_demo_upload",
            { upload_id: prepared.upload_id },
            undefined,
            publisher,
          )
        ).status === "processing",
        "Upload is pending real finalization",
      );
      return { prepared, input, started, metadataStarted };
    }),
  );
  // Use the production two-second polling cadence with ten independent claims per round.
  const finalization = await finalizeCapacityBatch(
    h,
    uploads.map((upload) => upload.prepared.upload_id),
    check,
  );
  // Observe each completed task after its own finalizer round.
  const processing = [];
  const publishTimes = [];
  for (const upload of uploads) {
    const result = await h.call(
      "get_demo_upload_status",
      { upload_id: upload.prepared.upload_id },
      undefined,
      publisher,
    );
    check(
      result.status === "completed" && result.password_status === "generated",
      "Every concurrent upload completes with a generated password",
    );
    upload.result = result;
    // The owning round barrier is a conservative upper bound for individual completion.
    const finished = finalization.completedAt.get(upload.prepared.upload_id);
    processing.push(finished - upload.metadataStarted);
    publishTimes.push(finished - upload.started);
  }
  if (percentile(processing) > 5000 || Math.max(...publishTimes) > 60_000)
    console.error(
      JSON.stringify({
        stage: "capacity-upload-threshold",
        metadataP95Ms: percentile(processing),
        maxPublishMs: Math.max(...publishTimes),
        rounds: finalization.rounds,
      }),
    );
  check(percentile(processing) <= 5000, "Metadata processing P95 <=5 seconds");
  check(Math.max(...publishTimes) <= 60_000, "All ten publication chains <=60 seconds");
  const publication = h.publicationMetrics();
  check(
    publication.server.getObjectCalls === 0 &&
      publication.server.bodyBytesRead === 0 &&
      publication.worker.getObjectCalls === 0 &&
      publication.worker.bodyBytesRead === 0,
    "Publication downloads zero object bodies",
  );
  const grants = await Promise.all(
    Array.from({ length: 20 }, async () => {
      const page = await https.request(
        `/auth/password?return_path=${encodeURIComponent(published.targetPath)}`,
      );
      check(page.status === 200, "Twenty first visitors load password page");
      const verified = await https.request("/auth/password/verify", {
        method: "POST",
        headers: {
          cookie: responseCookies(page),
          origin: h.demoUrl,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          state: responseState(page),
          password: published.result.access_password,
        }),
      });
      check(
        verified.status === 200,
        "Twenty simultaneous first visitors authorize under default limits",
      );
      return responseCookies(verified);
    }),
  );
  const expected = [...published.bodies.values()][0];
  const oneDemo = await readBurst(Array.from({ length: 20 }, (_, index) => grants[index]));
  const platformGrants = await Promise.all(
    uploads.map(async (upload) => {
      const path = new URL(upload.result.target_url).pathname;
      const page = await https.request(`/auth/password?return_path=${encodeURIComponent(path)}`);
      check(page.status === 200, "Each platform project offers real password entry");
      const verified = await https.request("/auth/password/verify", {
        method: "POST",
        headers: {
          cookie: responseCookies(page),
          origin: h.demoUrl,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          state: responseState(page),
          password: upload.result.access_password,
        }),
      });
      check(verified.status === 200, "Each platform project password authorizes");
      return {
        path,
        cookie: responseCookies(verified),
        expected: [...upload.input.bodies.values()][0],
      };
    }),
  );
  const hashBefore = { ...h.hashActivity };
  const platform = await Promise.all(
    Array.from({ length: 100 }, async (_, index) => {
      const target = platformGrants[index % platformGrants.length];
      const response = await timedRead(`${h.demoUrl}${target.path}`, { cookie: target.cookie });
      check(
        response.status === 200 && response.body.equals(target.expected),
        "Platform100 reads return exact bytes across ten projects",
      );
      return response.ttfbMs;
    }),
  );
  check(
    h.hashActivity.generate === hashBefore.generate && h.hashActivity.verify === hashBefore.verify,
    "Static reads perform no password hashing",
  );
  check(
    percentile(oneDemo) <= 500 && percentile(platform) <= 500,
    "Single-demo20 and platform100 static TTFB P95 <=500ms",
  );
  const management = await Promise.all(
    Array.from({ length: 100 }, async (_, index) => {
      const path = index % 2 ? "/api/projects" : "/api/tokens";
      const response = await timedRead(`http://127.0.0.1:55100${path}`, { cookie: h.appCookie });
      check(response.status === 200, "Concurrent real management APIs succeed");
      JSON.parse(response.body.toString());
      // Management API requirement is complete response latency, including JSON transfer.
      return response.durationMs;
    }),
  );
  check(percentile(management) <= 500, "Management API P95 <=500ms");
  const finalBacklog = await backlog(h.prisma, h.tenantId);
  check(
    finalBacklog.incompleteUploads === 0 && finalBacklog.cleanupPending === 0,
    "Owned upload/cleanup queues have no backlog",
  );
  sampling = false;
  await sampler;
  const final = await databaseSample(h.prisma, provider);
  samples.push(final);
  check(
    sampleErrors.length === 0 && samples.length > 1,
    "Connection and lock telemetry captured during load",
  );
  check(
    samples.every(
      (value) =>
        Number.isFinite(value.connections) &&
        Number.isFinite(value.currentLockWaits) &&
        Number.isFinite(value.deadlocks),
    ),
    "Database telemetry is numeric",
  );
  console.log(
    JSON.stringify(
      capacityReport({
        assertions,
        provider,
        readiness: h.readinessEvidence(),
        processing,
        publishTimes,
        publication,
        finalizationRounds: finalization.rounds,
        oneDemo,
        platform,
        platformProjects: platformGrants.length,
        management,
        samples,
        initial,
        final,
        transactionActivity,
        finalBacklog,
      }),
    ),
  );

  async function readBurst(cookies) {
    return Promise.all(
      cookies.map(async (cookie) => {
        const response = await timedRead(`${h.demoUrl}${published.targetPath}`, { cookie });
        check(
          response.status === 200 && response.body.equals(expected),
          "Concurrent static read returns exact bytes",
        );
        return response.ttfbMs;
      }),
    );
  }
} catch (error) {
  if (error?.name === "AssertionError") console.error(error.message);
  console.error(
    `Capacity failure location=${[...(error?.stack ?? "").matchAll(/database-capacity[-a-z]*\.mjs:\d+:\d+/g)].map((item) => item[0]).join(",") || "setup"}`,
  );
  console.error(
    "Real database capacity smoke failed; performance, successful responses and lock telemetry are mandatory",
  );
  process.exitCode = 1;
} finally {
  sampling = false;
  if (sampler) await sampler;
  if (https) await https.close();
  await h.cleanup();
}
