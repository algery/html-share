import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHarness, isolatedConfiguration } from "./password-smoke-support.mjs";
import { startPasswordHttps } from "./password-https-harness.mjs";
import { publishAccessFixture } from "./password-access-fixture.mjs";
import {
  passwordReadCookie,
  prepareK6Upload,
  runK6,
  startK6Worker,
} from "./password-k6-support.mjs";

const config = isolatedConfiguration();
let assertions = 0;
const check = (value, message) => {
  if (!value) throw new Error(message);
  assertions++;
};
const results = [];
const outputDirectory = resolve(process.env.PASSWORD_K6_RESULTS_DIR ?? "test-results/password-k6");
await mkdir(outputDirectory, { recursive: true });

for (const stage of ["correct", "read", "wrong", "upload"]) {
  const directory = await mkdtemp(join(tmpdir(), "html-share-password-k6-"));
  let h;
  let https;
  let stopWorker;
  let cleanupFailed = false;
  try {
    h = await createHarness(config, check, {
      passwordAccess: true,
      defaultRateLimits: true,
      demoUrl: "https://localhost:55443",
    });
    https = await startPasswordHttps();
    const secrets = [
      h.mcpToken,
      process.env.PASSWORD_RESULT_ENCRYPTION_KEY,
      process.env.PASSWORD_MANAGEMENT_ENCRYPTION_KEY,
    ];
    const originalGenerate = h.crypto.generate;
    h.crypto.generate = async (...args) => {
      const value = await originalGenerate(...args);
      secrets.push(value.password);
      return value;
    };
    const environment = {
      ACCESS_MODE: "password",
      DEMO_BASE_URL: "https://host.docker.internal:55443",
      DEMO_HOST: "localhost",
      DEMO_ORIGIN: "https://localhost:55443",
    };
    let expectedReads;
    let expectedBytes;
    let script;
    let path;
    if (stage === "upload") {
      const prepared = await prepareK6Upload(directory);
      Object.assign(environment, prepared.environment, {
        APP_HOST: "127.0.0.1",
        MCP_ENDPOINT: "http://host.docker.internal:55100/mcp",
        MCP_TOKEN: h.mcpToken,
        UPLOAD_CONNECT_HOST: "host.docker.internal",
      });
      script = "upload.js";
      expectedReads = 10;
      expectedBytes = 10 * prepared.bodySize;
      stopWorker = startK6Worker(h);
    } else {
      const published = await publishAccessFixture(h, check);
      path = new URL(published.result.target_url).pathname;
      const body = published.bodies.get([...published.bodies.keys()][0]);
      Object.assign(environment, {
        DEMO_PATH: path,
        ACCESS_PASSWORD: published.result.access_password,
      });
      secrets.push(published.result.access_password);
      expectedReads = stage === "correct" ? 20 : stage === "read" ? 100 : 0;
      expectedBytes = expectedReads * body.length;
      if (stage === "read") {
        environment.PASSWORD_COOKIE = await passwordReadCookie(
          https,
          path,
          published.result.access_password,
          secrets,
          check,
        );
        environment.BASE_URL = environment.DEMO_BASE_URL;
        script = "demo-read.js";
      } else {
        environment.VERIFY_MODE = stage;
        script = "password-verify.js";
      }
    }
    const beforeHashes = h.hashActivity.verify;
    const result = await runK6(script, environment, directory, secrets, check);
    if (stopWorker) {
      await stopWorker();
      stopWorker = undefined;
    }
    await writeFile(join(outputDirectory, `${stage}.log`), result.output, { mode: 0o600 });
    check(result.code === 0, `k6 ${stage} meets all configured checks and thresholds`);
    if (stage === "read")
      check(h.hashActivity.verify === beforeHashes, "100 credential reads do not invoke scrypt");
    if (stage === "correct")
      check(
        h.hashActivity.verify - beforeHashes === 20,
        "20 first visits verify exactly once each",
      );
    if (stage === "wrong") {
      const login = await https.request(
        `/auth/content-login?return_path=${encodeURIComponent(path)}`,
      );
      check(login.status === 200, "password throttling preserves the DingTalk login budget");
    }
    const metrics = h.publicationMetrics();
    check(
      metrics.worker.getObjectCalls === 0 && metrics.worker.bodyBytesRead === 0,
      "k6 finalizers never retrieve object bodies",
    );
    check(
      metrics.server.getObjectCalls === expectedReads &&
        metrics.server.bodyBytesRead === expectedBytes,
      "application object GETs and bytes exactly match authorized content reads",
    );
    results.push({
      stage,
      metrics: result.summary.metrics,
      objectActivity: metrics,
      passwordVerifications: h.hashActivity.verify - beforeHashes,
    });
    process.stdout.write(`k6 ${stage}: PASS\n`);
  } finally {
    const failures = [];
    for (const cleanup of [
      async () => {
        if (stopWorker) await stopWorker();
      },
      async () => {
        if (https) await https.close();
      },
      async () => {
        if (h) await h.cleanup();
      },
      () => rm(directory, { recursive: true, force: true }),
    ]) {
      try {
        await cleanup();
      } catch {
        failures.push("isolated k6 cleanup failed");
      }
    }
    cleanupFailed = failures.length > 0;
  }
  if (cleanupFailed) throw new Error("Isolated k6 cleanup failed");
}
await writeFile(
  join(outputDirectory, "summary.json"),
  JSON.stringify({ assertions, results }, null, 2),
  { mode: 0o600 },
);
process.stdout.write(`k6 password capacity: ${assertions} assertions passed\n`);
