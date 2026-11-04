import assert from "node:assert/strict";
import { requireCapacityReadiness } from "./database-capacity-report.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDatabaseReadiness,
  createDatabaseClient,
  readRequiredDatabaseMigrations,
} from "../packages/db/dist/index.js";
import {
  matrixConfiguration,
  runCaptured,
  smokeReport,
  requirePassedAssertions,
  isolatedUrl,
} from "./database-compatibility-support.mjs";

// Mandatory entry point: no backend, browser or capacity opt-out flags.
let directory;
try {
  assert(process.argv.length === 2, "The complete compatibility matrix does not accept skip flags");
  const configurations = matrixConfiguration();
  for (const config of configurations) {
    for (const databaseUrl of [config.contractUrl, config.databaseUrl]) {
      const connection = createDatabaseClient({
        DATABASE_PROVIDER: config.provider,
        DATABASE_URL: databaseUrl,
      });
      try {
        await checkDatabaseReadiness(
          connection,
          await readRequiredDatabaseMigrations(connection.provider),
        );
      } finally {
        await connection.client.$disconnect();
      }
    }
  }
  directory = await mkdtemp(join(tmpdir(), "html-share-phase26-matrix-"));
  const migration = smokeReport(
    runCaptured("scripts/database-migration-smoke.mjs"),
    "database-migration-smoke-ok",
  );
  runCaptured("scripts/database-contract-check.mjs");
  for (const provider of ["POSTGRES", "MYSQL"])
    isolatedUrl(
      process.env[`PHASE26_GATE_${provider}_URL`],
      provider === "MYSQL" ? "mysql" : "postgresql",
      /^html_share_phase26_gate$/,
    );
  const deploymentReport = join(directory, "deployment.json");
  runCaptured("node_modules/vitest/vitest.mjs", {}, [
    "run",
    "scripts/database-deployment.integration.test.mjs",
    "--reporter=json",
    `--outputFile=${deploymentReport}`,
  ]);
  const deploymentAssertions = requirePassedAssertions(
    JSON.parse(await readFile(deploymentReport, "utf8")),
  );
  assert(deploymentAssertions >= 24, "All deployment gate cases must run");
  const instanceClone = smokeReport(
    runCaptured("scripts/database-instance-clone-smoke.mjs", {}, [], 600_000),
    "database-instance-clone-ok",
    0,
  );
  assert(
    instanceClone.results?.length === 2 &&
      ["postgresql", "mysql"].every((provider) =>
        instanceClone.results.some((item) => item.provider === provider),
      ) &&
      instanceClone.results.every(
        (item) =>
          [
            "sameDatabaseName",
            "copiedStoredIdentity",
            "actualInstancesDistinguished",
            "workerMismatchRejected",
          ].every((key) => item[key] === true) && item.businessTablesUnchanged === 30,
      ),
    "Copied same-name databases on different physical servers must reject Worker startup without business writes",
  );
  const results = [];
  for (const config of configurations) {
    const mockReport = join(directory, `${config.provider}-mock.json`);
    const passwordBrowserReport = join(directory, `${config.provider}-password.json`);
    const environment = {
      PHASE25_DATABASE_PROVIDER: config.provider,
      PHASE25_DATABASE_URL: config.databaseUrl,
      PHASE26_BROWSER_MOCK_REPORT: mockReport,
      PHASE26_PASSWORD_BROWSER_REPORT: passwordBrowserReport,
    };
    const checks = [
      ["password-publication-smoke.mjs", "phase10-password-publication-ok", 297, []],
      ["password-access-smoke.mjs", "password-access-smoke-ok", 126, ["--browser"]],
      ["password-management-smoke.mjs", "password-management-smoke-ok", 71, []],
      ["password-security-smoke.mjs", "password-security-smoke-ok", 1, []],
      ["database-browser-smoke.mjs", "database-browser-smoke-ok", 1, []],
      ["database-capacity-smoke.mjs", "database-capacity-smoke-ok", 1, []],
    ];
    const evidence = [];
    for (const [script, status, minimum, args] of checks) {
      const report = smokeReport(
        runCaptured(`scripts/${script}`, environment, args, 600_000),
        status,
        minimum,
      );
      if (script === "password-access-smoke.mjs") {
        assert(report.browser === "passed", "Password browsers required");
        const passwordBrowser = JSON.parse(await readFile(passwordBrowserReport, "utf8"));
        assert(
          passwordBrowser.result === "passed" &&
            passwordBrowser.tests.every(
              (test) =>
                test.expectedStatus === "passed" &&
                test.statuses.length > 0 &&
                test.statuses.every((status) => status === "passed"),
            ) &&
            passwordBrowser.stats.expected >= 14 &&
            passwordBrowser.stats.unexpected === 0 &&
            passwordBrowser.stats.skipped === 0 &&
            passwordBrowser.stats.flaky === 0,
          "Password browser tests must pass with zero skips/flaky results",
        );
      }
      if (script === "database-capacity-smoke.mjs") requireCapacityReadiness(report);
      evidence.push(report);
      console.log(
        JSON.stringify({
          stage: script,
          provider: config.provider,
          assertions: report.assertions,
          result: "passed",
        }),
      );
    }
    // The intercepted-API UI regression remains separate from real backend tests.
    const mock = await readFile(mockReport, "utf8");
    const summary = JSON.parse(mock);
    assert(
      summary.stats.expected > 0 &&
        summary.stats.skipped === 0 &&
        summary.stats.unexpected === 0 &&
        summary.stats.flaky === 0,
      "Existing UI regression must pass without skipped/flaky tests",
    );
    results.push({ provider: config.provider, evidence, mockAssertions: summary.stats.expected });
  }
  const image = smokeReport(
    runCaptured("scripts/database-image-smoke.mjs", {}, [], 600_000),
    "database-image-smoke-ok",
    0,
  );
  assert(
    image.results?.length === 2 &&
      ["postgresql", "mysql"].every((provider) =>
        image.results.some((item) => item.provider === provider),
      ),
    "Both image backends required",
  );
  assert(
    ["serverImage", "workerImage"].every(
      (key) =>
        typeof image.results[0][key] === "string" &&
        /^sha256:[a-f0-9]{64}$/.test(image.results[0][key]) &&
        image.results[0][key] === image.results[1][key],
    ),
    "Same immutable Server/Worker image IDs required across providers",
  );
  const restoration = smokeReport(
    runCaptured("scripts/database-backup-restore-smoke.mjs", {}, [], 600_000),
    "database-backup-restore-ok",
    0,
  );
  assert(
    restoration.results?.length === 2 &&
      ["postgresql", "mysql"].every((provider) =>
        restoration.results.some((item) => item.provider === provider),
      ),
    "Both backup/restore providers required",
  );
  assert(
    restoration.results.every(
      (item) =>
        item.models === 16 &&
        item.dumpBytes > 0 &&
        item.sourceUnchanged &&
        item.migrationChecksumsPreserved &&
        item.restoredCopyDistinguished,
    ),
    "Complete restored data and unchanged source/checksums required",
  );
  const restoredChecks = [
    "activePasswordProject",
    "passwordGrantVerified",
    "exactPathBodyVerified",
    "deletedAccessDenied",
    "restoredObjectsCleaned",
    "sourceObjectsUnchanged",
    "sourceDatabaseUnchanged",
  ];
  assert(
    restoration.results.every(
      (item) =>
        item.business &&
        restoredChecks.every((key) => item.business[key] === true) &&
        item.business.restoredObjects > 0 &&
        item.business.backupBodyBytes > 0 &&
        item.business.cleanupJobsCompleted > 0,
    ),
    "Restored password access, exact object bytes, deletion, cleanup and unchanged source require real evidence",
  );
  console.log(
    JSON.stringify({
      status: "database-compatibility-check-ok",
      restoration,
      image,
      deploymentAssertions,
      instanceClone,
      providers: results,
      migration,
      assertions: results.reduce(
        (sum, value) => sum + value.evidence.reduce((count, entry) => count + entry.assertions, 0),
        0,
      ),
    }),
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Mandatory database compatibility matrix failed",
  );
  process.exitCode = 1;
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
}
