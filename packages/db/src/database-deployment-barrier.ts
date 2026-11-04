import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

import {
  assertSameDatabaseDeployment,
  type DatabaseDeploymentIdentity,
} from "./database-readiness.js";

export interface DatabaseDeploymentTarget extends DatabaseDeploymentIdentity {
  nonce: string;
}
export interface DatabaseDeploymentBarrier {
  targetFile: string;
  role: "server" | "worker";
  timeoutMs?: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failure(): Error {
  return new Error(
    "Database deployment approval failed; verify migration target and both service configurations",
  );
}

function targetValue(value: unknown): DatabaseDeploymentTarget {
  if (
    typeof value !== "object" ||
    value === null ||
    !("provider" in value) ||
    (value.provider !== "postgresql" && value.provider !== "mysql") ||
    !("instanceId" in value) ||
    typeof value.instanceId !== "string" ||
    !UUID.test(value.instanceId) ||
    !("logicalTarget" in value) ||
    typeof value.logicalTarget !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.logicalTarget) ||
    !("schemaVersion" in value) ||
    typeof value.schemaVersion !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.schemaVersion) ||
    !("nonce" in value) ||
    typeof value.nonce !== "string" ||
    !UUID.test(value.nonce)
  )
    throw failure();
  return {
    provider: value.provider,
    instanceId: value.instanceId,
    schemaVersion: value.schemaVersion,
    logicalTarget: value.logicalTarget,
    nonce: value.nonce,
  };
}

async function readTarget(file: string): Promise<DatabaseDeploymentTarget> {
  const source = await readFile(file, "utf8");
  if (source.length > 4096) throw failure();
  return targetValue(JSON.parse(source) as unknown);
}

async function writeAtomic(file: string, value: DatabaseDeploymentTarget): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}

/** Invalidate the previous process receipt even when its replacement cannot connect. */
export async function invalidateDatabaseDeploymentReceipt(
  options: DatabaseDeploymentBarrier,
): Promise<void> {
  try {
    if (!isAbsolute(options.targetFile) || options.targetFile.includes("\0")) throw failure();
    await rm(`${options.targetFile}.${options.role}`, { force: true });
  } catch {
    throw failure();
  }
}

/** A new nonce invalidates every receipt from a preceding migration/deployment. */
export async function writeDatabaseDeploymentTarget(
  targetFile: string,
  identity: DatabaseDeploymentIdentity,
): Promise<void> {
  try {
    if (!isAbsolute(targetFile) || targetFile.includes("\0")) throw failure();
    await writeAtomic(targetFile, targetValue({ ...identity, nonce: randomUUID() }));
  } catch {
    throw failure();
  }
}

/** No database writes or application listeners are started before BOTH actual roles agree. */
export async function joinDatabaseDeployment(
  identity: DatabaseDeploymentIdentity,
  options: DatabaseDeploymentBarrier,
): Promise<() => Promise<void>> {
  try {
    const target = await readTarget(options.targetFile);
    assertSameDatabaseDeployment([target, identity]);
    await writeAtomic(`${options.targetFile}.${options.role}`, target);
    const validate = async () => {
      const current = await readTarget(options.targetFile);
      if (current.nonce !== target.nonce) throw failure();
      assertSameDatabaseDeployment([target, current]);
      for (const role of ["server", "worker"]) {
        const receipt = await readTarget(`${options.targetFile}.${role}`);
        if (receipt.nonce !== target.nonce) throw failure();
        assertSameDatabaseDeployment([target, receipt]);
      }
    };
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    while (true) {
      try {
        await validate();
        break;
      } catch {
        if (Date.now() >= deadline) throw failure();
        // Replaced/missing approval is terminal. Missing peer receipt can still arrive.
        if ((await readTarget(options.targetFile)).nonce !== target.nonce) throw failure();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return async () => {
      try {
        await validate();
      } catch {
        throw failure();
      }
    };
  } catch {
    throw failure();
  }
}
