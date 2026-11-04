import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSameDatabaseDeployment,
  checkDatabaseReadiness,
  joinDatabaseDeployment,
  readRequiredDatabaseMigrations,
  writeDatabaseDeploymentTarget,
} from "../packages/db/dist/index.js";

/** Match production startup/readiness while sharing the harness's five-connection pool. */
export async function createSmokeReadiness(connection) {
  const directory = await mkdtemp(join(tmpdir(), "html-share-smoke-readiness-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const required = await readRequiredDatabaseMigrations(connection.provider);
    const identity = await checkDatabaseReadiness(connection, required);
    const targetFile = join(directory, "target.json");
    await writeDatabaseDeploymentTarget(targetFile, identity);
    const roles = ["server", "worker"];
    // Both actual roles perform SQL and join the real nonce/receipt barrier before any listener.
    const checks = await Promise.all(
      roles.map(async (role) => {
        const actual = await checkDatabaseReadiness(connection, required);
        assertSameDatabaseDeployment([identity, actual]);
        return joinDatabaseDeployment(actual, { targetFile, role, timeoutMs: 5000 });
      }),
    );
    const counts = { server: 0, worker: 0 };
    const readiness = (index) => async () => {
      // Same order as openDatabaseRepositories.readiness: receipts, then SQL/checksums/identity.
      await checks[index]();
      assertSameDatabaseDeployment([identity, await checkDatabaseReadiness(connection, required)]);
      counts[roles[index]]++;
    };
    return {
      cleanup,
      serverReadiness: readiness(0),
      workerReadiness: readiness(1),
      snapshot: () => ({
        sql: true,
        checksums:
          required.length > 0 && required.every((entry) => /^[a-f0-9]{64}$/.test(entry.checksum)),
        identity: true,
        deploymentReceipts: true,
        startupRoles: roles.length,
        serverOnRequest: counts.server > 0,
        workerPolling: counts.worker > 0,
        serverChecks: counts.server,
        workerChecks: counts.worker,
      }),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
