import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  invalidateDatabaseDeploymentReceipt,
  joinDatabaseDeployment,
  writeDatabaseDeploymentTarget,
} from "./database-deployment-barrier.js";

const identity = {
  provider: "postgresql",
  instanceId: randomUUID(),
  schemaVersion: "a".repeat(64),
  logicalTarget: "b".repeat(64),
} as const;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function targetFile() {
  const directory = await mkdtemp(join(tmpdir(), "html-share-deployment-"));
  directories.push(directory);
  const target = join(directory, "target.json");
  await writeDatabaseDeploymentTarget(target, identity);
  return target;
}

it("permits neither role before both actual identities approve the same nonce", async () => {
  const file = await targetFile();
  let serverStarted = false;
  const server = joinDatabaseDeployment(identity, {
    targetFile: file,
    role: "server",
    timeoutMs: 1000,
  }).then((validate) => {
    serverStarted = true;
    return validate;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(serverStarted).toBe(false);
  const worker = joinDatabaseDeployment(identity, {
    targetFile: file,
    role: "worker",
    timeoutMs: 1000,
  });
  const validators = await Promise.all([server, worker]);
  await Promise.all(validators.map((validate) => validate()));
  expect(serverStarted).toBe(true);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});

it("rejects a mismatched role and prevents the correctly configured peer from starting", async () => {
  const file = await targetFile();
  const server = joinDatabaseDeployment(identity, {
    targetFile: file,
    role: "server",
    timeoutMs: 150,
  });
  const expected = expect(server).rejects.toThrow("Database deployment approval failed");
  await expect(
    joinDatabaseDeployment(
      { ...identity, instanceId: randomUUID() },
      {
        targetFile: file,
        role: "worker",
        timeoutMs: 150,
      },
    ),
  ).rejects.toThrow("Database deployment approval failed");
  await expected;
});

it("invalidates stale receipts for a new deployment and fails runtime readiness closed", async () => {
  const file = await targetFile();
  const validators = await Promise.all([
    joinDatabaseDeployment(identity, { targetFile: file, role: "server", timeoutMs: 1000 }),
    joinDatabaseDeployment(identity, { targetFile: file, role: "worker", timeoutMs: 1000 }),
  ]);
  const old = await readFile(file, "utf8");
  await writeDatabaseDeploymentTarget(file, identity);
  expect(await readFile(file, "utf8")).not.toBe(old);
  await expect(validators[0]?.()).rejects.toThrow("Database deployment approval failed");
  await expect(
    joinDatabaseDeployment(identity, { targetFile: file, role: "server", timeoutMs: 100 }),
  ).rejects.toThrow("Database deployment approval failed");
});

it("clears a restarted role's old approval before any replacement SQL can fail", async () => {
  const file = await targetFile();
  const validators = await Promise.all([
    joinDatabaseDeployment(identity, { targetFile: file, role: "server", timeoutMs: 1000 }),
    joinDatabaseDeployment(identity, { targetFile: file, role: "worker", timeoutMs: 1000 }),
  ]);
  await invalidateDatabaseDeploymentReceipt({ targetFile: file, role: "worker" });
  await expect(validators[0]?.()).rejects.toThrow("Database deployment approval failed");
  await expect(readFile(`${file}.worker`)).rejects.toThrow();
});
