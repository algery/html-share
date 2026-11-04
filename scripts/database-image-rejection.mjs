import assert from "node:assert/strict";
import { createDatabaseClient } from "../packages/db/dist/index.js";

const models = [
  "tenant",
  "user",
  "demoProject",
  "revision",
  "fileObject",
  "uploadFile",
  "uploadTask",
  "quotaReservation",
  "mcpToken",
  "accessSession",
  "authState",
  "passwordAccessGrant",
  "cleanupJob",
  "objectSweepState",
  "auditLog",
];

export async function rejectMismatchedImage({
  docker,
  common,
  envArgs,
  provider,
  server,
  worker,
  databaseUrl,
  names,
}) {
  const actual = new URL(databaseUrl);
  const other = new URL(databaseUrl);
  other.pathname = "/html_share_phase26_gate_other";
  const hostUrl = (target) => {
    const url = new URL(target);
    url.hostname = "127.0.0.1";
    url.port = provider === "mysql" ? "53319" : "55439";
    return url.toString();
  };
  const connections = [actual, other].map((url) =>
    createDatabaseClient({ DATABASE_PROVIDER: provider, DATABASE_URL: hostUrl(url) }),
  );
  const snapshot = async () =>
    Promise.all(
      connections.map((connection) =>
        Promise.all(models.map((model) => connection.client[model].count())),
      ),
    );
  try {
    const before = await snapshot();
    // A new deployment nonce must invalidate both receipts from the positive run.
    await docker(
      "run",
      "--rm",
      ...common,
      ...envArgs,
      server,
      "node",
      "/workspace/scripts/database-deployment-preflight.mjs",
      "--write-target=/deployment-target/target.json",
    );
    const started = [];
    for (const [role, image, port, internal] of [
      ["server", server, 55531, 3001],
      ["worker", worker, 55532, 3002],
    ]) {
      const name = `html-share-phase26-rejected-${provider}-${role}`;
      names.push(name);
      started.push(name);
      await docker(
        "run",
        "-d",
        "--name",
        name,
        ...common,
        "--cpus=1",
        "--memory=768m",
        "-p",
        `127.0.0.1:${port}:${internal}`,
        ...envArgs,
        ...(role === "worker" ? ["-e", `DATABASE_URL=${other}`] : []),
        image,
      );
    }
    const deadline = Date.now() + 45_000;
    let stopped = false;
    while (Date.now() < deadline) {
      for (const port of [55531, 55532]) {
        let connected = false;
        try {
          await fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(300) });
          connected = true;
        } catch {
          // A closed listener is the required outcome for a rejected deployment.
        }
        assert.equal(
          connected,
          false,
          "mismatched deployment must never open either business listener",
        );
      }
      const states = await Promise.all(
        started.map((name) =>
          docker("inspect", "--format", "{{.State.Running}}:{{.State.ExitCode}}", name),
        ),
      );
      if (states.every((state) => state.startsWith("false:"))) {
        assert(
          states.every((state) => state !== "false:0"),
          "both rejected processes must fail",
        );
        stopped = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(stopped, "mismatched deployment must terminate within its bounded barrier timeout");
    assert.deepEqual(
      await snapshot(),
      before,
      "neither logical database may receive business writes",
    );
    return {
      mismatchedWorkerRejected: true,
      bothListenersClosed: true,
      businessTablesUnchanged: models.length * 2,
    };
  } finally {
    await Promise.all(connections.map((connection) => connection.client.$disconnect()));
  }
}
