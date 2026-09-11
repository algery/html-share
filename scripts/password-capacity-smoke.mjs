import assert from "node:assert/strict";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { createHarness, fixture, isolatedConfiguration } from "./password-smoke-support.mjs";
import { startPasswordHttps } from "./password-https-harness.mjs";
import {
  publishAccessFixture,
  responseCookies,
  responseState,
} from "./password-access-fixture.mjs";

let assertions = 0;
const check = (condition, message) => {
  assert(condition, message);
  assertions++;
};
const h = await createHarness(isolatedConfiguration(), check, {
  passwordAccess: true,
  demoUrl: "https://localhost:55443",
  defaultRateLimits: true,
});
let https;
let sample;
const delay = monitorEventLoopDelay({ resolution: 10 });
try {
  https = await startPasswordHttps();
  const published = await publishAccessFixture(h, check);
  // A second publisher has the full default ten-prepare budget, without changing limits.
  const publisher = await h.otherClient();
  const processing = [];
  const publicationTimes = [];
  const tasks = await Promise.all(
    Array.from({ length: 10 }, async (_, index) => {
      const started = performance.now();
      const input = fixture(index, { access_mode: "password" });
      const prepared = await h.call("prepare_demo_upload", input.args, undefined, publisher);
      check(
        prepared.status === "prepared",
        "ten simultaneous password prepares accepted by defaults",
      );
      for (const upload of prepared.uploads) {
        const response = await fetch(upload.upload_url, {
          method: "PUT",
          headers: upload.upload_headers,
          body: input.bodies.get(upload.relative_path),
        });
        check(response.ok, "capacity fixture PUT succeeds");
      }
      const notified = performance.now();
      const completed = await h.call(
        "complete_demo_upload",
        { upload_id: prepared.upload_id },
        undefined,
        publisher,
      );
      check(completed.status === "processing", "capacity upload awaits real worker");
      return { prepared, input, started, notified };
    }),
  );
  const finalizers = await Promise.all(Array.from({ length: 10 }, () => h.finalize()));
  check(
    finalizers.every((value) => value === "published"),
    "ten concurrent real finalizers publish",
  );
  for (const task of tasks) {
    const result = await h.call(
      "get_demo_upload_status",
      { upload_id: task.prepared.upload_id },
      undefined,
      publisher,
    );
    check(
      result.status === "completed" && result.password_status === "generated",
      "all ten uploads return generated password only after completion",
    );
    processing.push(performance.now() - task.notified);
    publicationTimes.push(performance.now() - task.started);
    task.result = result;
  }
  const publicationMetrics = h.publicationMetrics();
  check(
    publicationMetrics.server.getObjectCalls === 0 && publicationMetrics.server.bodyBytesRead === 0,
    "server publication GET/bytes zero",
  );
  check(
    publicationMetrics.worker.getObjectCalls === 0 && publicationMetrics.worker.bodyBytesRead === 0,
    "worker publication GET/bytes zero",
  );
  check(
    percentile(processing, 0.95) <= 5000 && Math.max(...publicationTimes) <= 60000,
    "ten uploads meet processing and end-to-end thresholds",
  );

  const sessions = await Promise.all(
    Array.from({ length: 20 }, () => pageFor(published.targetPath)),
  );
  const verifyStarted = performance.now();
  const verified = await Promise.all(
    sessions.map((page) => verify(page, published.result.access_password)),
  );
  check(
    verified.every((response) => response.status === 200),
    "twenty first visitors on one exit authorize without default rate limits",
  );
  const firstVisitMs = performance.now() - verifyStarted;
  const cookie = responseCookies(verified[0]);
  const baselineHashCounts = { ...h.hashActivity };
  const readDurations = await readBurst(100, cookie);
  check(
    h.hashActivity.verify === baselineHashCounts.verify &&
      h.hashActivity.generate === baselineHashCounts.generate,
    "file reads perform no password hashing",
  );
  check(percentile(readDurations, 0.95) <= 500, "100 simultaneous grant reads P95 <=500ms");

  // Verify all ten newly published passwords, each with its own project policy.
  for (const task of tasks) {
    const path = new URL(task.result.target_url).pathname;
    const grant = await verify(await pageFor(path), task.result.access_password);
    check(grant.status === 200, "capacity generated password actually authorizes");
    const content = await https.request(path, { headers: { cookie: responseCookies(grant) } });
    check(
      content.status === 200 && content.body.equals([...task.input.bodies.values()][0]),
      "capacity upload bytes are accurate",
    );
  }

  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  delay.enable();
  sample = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 10);
  const pressure = Promise.allSettled(Array.from({ length: 35 }, () => h.crypto.generate()));
  const pressureReads = await readBurst(100, cookie);
  const pressureResults = await pressure;
  check(
    pressureResults.filter((x) => x.status === "fulfilled").length === 34 &&
      pressureResults.filter((x) => x.status === "rejected").length === 1,
    "crypto admits exactly two active plus 32 queued and rejects excess",
  );
  check(percentile(pressureReads, 0.95) <= 500, "hash saturation does not starve content reads");
  check(
    peakRss - baselineRss <= 160 * 1024 * 1024,
    "hash saturation RSS growth remains within local 160MiB budget",
  );
  clearInterval(sample);
  sample = undefined;
  delay.disable();

  const beforeWrong = h.hashActivity.verify;
  const wrongPage = sessions[0];
  const wrong = [];
  for (let i = 0; i < 40; i++) wrong.push(await verify(wrongPage, "Wrng2345"));
  check(
    wrong.some((r) => r.status === 401) && wrong.some((r) => r.status === 429),
    "wrong password attempts reach recoverable 429",
  );
  check(
    wrong.filter((r) => r.status === 429).every((r) => Number(r.headers["retry-after"]) > 0),
    "rate limit includes Retry-After",
  );
  check(
    h.hashActivity.verify - beforeWrong === wrong.filter((r) => r.status === 401).length,
    "rejected attempts never enter expensive verification",
  );
  const login = await https.request(
    `/auth/content-login?return_path=${encodeURIComponent(published.targetPath)}`,
  );
  check(login.status === 200, "password rate limit leaves DingTalk login budget available");
  const grantRows = await h.prisma.passwordAccessGrant.findMany({
    where: { tenantId: h.tenantId },
  });
  const stored = JSON.stringify(
    await h.prisma.uploadTask.findMany({ where: { tenantId: h.tenantId } }),
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
  );
  check(
    !stored.includes(published.result.access_password) &&
      tasks.every((t) => !stored.includes(t.result.access_password)),
    "real database upload tasks contain no plaintext generated password",
  );
  check(
    grantRows.every((row) => /^[a-f0-9]{64}$/.test(row.grantHash)),
    "database stores only grant digests",
  );
  check(
    !JSON.stringify(h.trace).includes(published.result.access_password),
    "worker trace contains no generated password",
  );
  console.log(
    JSON.stringify({
      status: "password-capacity-smoke-ok",
      assertions,
      defaultRateLimits: true,
      uploads: {
        count: 10,
        processingP95Ms: round(percentile(processing, 0.95)),
        maxPublishMs: round(Math.max(...publicationTimes)),
        publication: publicationMetrics,
      },
      firstVisitors: { count: 20, success: 20, durationMs: round(firstVisitMs) },
      reads: { concurrency: 100, p95Ms: round(percentile(readDurations, 0.95)), hashes: 0 },
      pressure: {
        admitted: 34,
        rejected: 1,
        readsP95Ms: round(percentile(pressureReads, 0.95)),
        rssGrowthMiB: round((peakRss - baselineRss) / 1024 / 1024),
        eventLoopMaxMs: round(delay.max / 1e6),
      },
      wrongPasswords: {
        unauthorized: wrong.filter((r) => r.status === 401).length,
        limited: wrong.filter((r) => r.status === 429).length,
        dingtalkStatus: login.status,
      },
    }),
  );

  async function pageFor(path) {
    const response = await https.request(`/auth/password?return_path=${encodeURIComponent(path)}`);
    check(response.status === 200, "capacity password page loads");
    return { state: responseState(response), cookie: responseCookies(response) };
  }
  async function verify(page, password) {
    return https.request("/auth/password/verify", {
      method: "POST",
      headers: { cookie: page.cookie, origin: h.demoUrl, "content-type": "application/json" },
      body: JSON.stringify({ state: page.state, password }),
    });
  }
  async function readBurst(count, grant) {
    return Promise.all(
      Array.from({ length: count }, async () => {
        const started = performance.now();
        const response = await https.request(published.targetPath, { headers: { cookie: grant } });
        check(
          response.status === 200 && response.body.equals([...published.bodies.values()][0]),
          "concurrent granted read returns exact body",
        );
        return performance.now() - started;
      }),
    );
  }
} finally {
  if (sample) clearInterval(sample);
  delay.disable();
  try {
    if (https) await https.close();
  } finally {
    await h.cleanup();
  }
}
function percentile(values, fraction) {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
}
function round(value) {
  return Math.round(value * 100) / 100;
}
