import assert from "node:assert/strict";
import { round, percentile } from "./database-capacity-observer.mjs";

export function capacityReport({
  assertions,
  provider,
  readiness,
  processing,
  publishTimes,
  publication,
  finalizationRounds,
  oneDemo,
  platform,
  platformProjects,
  management,
  samples,
  initial,
  final,
  transactionActivity,
  finalBacklog,
}) {
  requireCapacityReadiness({ readiness, uploads: { finalizationRounds } });
  return {
    status: "database-capacity-smoke-ok",
    assertions,
    provider,
    readiness,
    budget: { applicationPool: 5, nodeProcesses: 1, uploadConcurrency: 10, sameHarness: true },
    uploads: {
      count: 10,
      metadataP95UpperBoundMs: round(percentile(processing)),
      maxPublishUpperBoundMs: round(Math.max(...publishTimes)),
      publication,
      finalizationRounds,
    },
    reads: {
      singleDemoConcurrency: 20,
      singleDemoTtfbP95Ms: round(percentile(oneDemo)),
      platformConcurrency: 100,
      platformProjects,
      platformTtfbP95Ms: round(percentile(platform)),
    },
    management: { concurrency: 100, responseP95Ms: round(percentile(management)) },
    database: {
      samples: samples.length,
      peakConnections: Math.max(...samples.map((value) => value.connections)),
      peakActive: Math.max(...samples.map((value) => value.active)),
      peakLockWaits: Math.max(...samples.map((value) => value.currentLockWaits)),
      lockCountersScope: provider === "mysql" ? "server-global" : "selected-database",
      deadlocks: final.deadlocks - initial.deadlocks,
      lockWaits: final.lockWaits === undefined ? null : final.lockWaits - initial.lockWaits,
      transactions: transactionActivity,
    },
    backlog: finalBacklog,
  };
}

export function requireCapacityReadiness(report) {
  const evidence = report.readiness;
  assert(
    evidence &&
      [
        "sql",
        "checksums",
        "identity",
        "deploymentReceipts",
        "serverOnRequest",
        "workerPolling",
      ].every((key) => evidence[key] === true) &&
      evidence.startupRoles === 2 &&
      Number.isInteger(evidence.serverChecks) &&
      evidence.serverChecks > 0 &&
      Number.isInteger(evidence.workerChecks) &&
      evidence.workerChecks > 0 &&
      evidence.workerChecks === report.uploads?.finalizationRounds?.length,
    "Capacity requires real SQL/checksum/identity and two-role deployment receipt checks on HTTP requests and every worker round",
  );
}
