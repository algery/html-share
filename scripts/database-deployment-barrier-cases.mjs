import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import * as database from "../packages/db/dist/index.js";

export function registerDeploymentBarrierTests(environment) {
  async function approvalTarget() {
    const directory = await mkdtemp(join(tmpdir(), "html-share-gate-"));
    const targetFile = join(directory, "target.json");
    const connection = database.createDatabaseClient(environment());
    try {
      const required = await database.readRequiredDatabaseMigrations(connection.provider);
      await database.writeDatabaseDeploymentTarget(
        targetFile,
        await database.checkDatabaseReadiness(connection, required),
      );
    } finally {
      await connection.client.$disconnect();
    }
    return { directory, targetFile };
  }

  it("allows both real processes only after their actual targets match the migration approval", async () => {
    const { directory, targetFile } = await approvalTarget();
    let repositories = [];
    try {
      repositories = await Promise.all(
        ["server", "worker"].map((role) =>
          database.openDatabaseRepositories(
            environment(),
            {},
            { targetFile, role, timeoutMs: 2000 },
          ),
        ),
      );
      await Promise.all(repositories.map((repository) => repository.readiness()));
      const connection = database.createDatabaseClient(environment());
      try {
        const required = await database.readRequiredDatabaseMigrations(connection.provider);
        await database.writeDatabaseDeploymentTarget(
          targetFile,
          await database.checkDatabaseReadiness(connection, required),
        );
      } finally {
        await connection.client.$disconnect();
      }
      for (const repository of repositories)
        await expect(repository.readiness()).rejects.toThrow("Database deployment approval failed");
    } finally {
      await Promise.all(repositories.map((repository) => repository.close()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects both processes before returning repositories if a real role overrides its target", async () => {
    const { directory, targetFile } = await approvalTarget();
    const connection = database.createDatabaseClient(environment());
    try {
      const before = await connection.client.authState.count();
      const results = await Promise.allSettled([
        database.openDatabaseRepositories(
          environment(),
          {},
          { targetFile, role: "server", timeoutMs: 300 },
        ),
        database.openDatabaseRepositories(
          environment("_other"),
          {},
          { targetFile, role: "worker", timeoutMs: 300 },
        ),
      ]);
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(await connection.client.authState.count()).toBe(before);
    } finally {
      await connection.client.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
