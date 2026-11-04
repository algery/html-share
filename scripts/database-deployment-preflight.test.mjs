import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { readDeploymentDatabases } from "./database-deployment-config.mjs";
import { checkDatabaseDeployment } from "./database-deployment-preflight.mjs";
import {
  assertSameDatabaseDeployment,
  DatabaseReadinessError,
} from "../packages/db/src/database-readiness.ts";

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const environment = {
  DATABASE_PROVIDER: "postgresql",
  DATABASE_URL: "postgresql://user:secret@localhost/db",
};
const identity = {
  provider: "postgresql",
  schemaVersion: "schema1",
  logicalTarget: "logical1",
  instanceId: "instance1",
};

function database(identities = [identity, identity, identity]) {
  const disconnect = vi.fn().mockResolvedValue(undefined);
  return {
    assertSameDatabaseDeployment,
    DatabaseReadinessError,
    createDatabaseClient: vi.fn((env) => ({
      provider: env.DATABASE_PROVIDER,
      client: { $disconnect: disconnect },
    })),
    readRequiredDatabaseMigrations: vi
      .fn()
      .mockResolvedValue([{ name: "migration1", checksum: "a".repeat(64) }]),
    checkDatabaseReadiness: vi.fn().mockImplementation(async () => identities.shift()),
    disconnect,
  };
}

it("uses the same validated environment for all three roles by default", async () => {
  const targets = await readDeploymentDatabases([], environment);
  expect(targets.map((target) => target.role)).toEqual(["server", "worker", "migration"]);
  expect(
    targets.every((target) => target.environment.DATABASE_URL === environment.DATABASE_URL),
  ).toBe(true);
});

it("loads each explicit role file without inheriting database configuration from the shell", async () => {
  const directory = await mkdtemp(join(tmpdir(), "html-share-preflight-"));
  directories.push(directory);
  const server = join(directory, "server.env");
  const worker = join(directory, "worker.env");
  const migration = join(directory, "migration.env");
  await writeFile(server, "DATABASE_URL=postgresql://user:file-secret@server/db\n");
  await writeFile(
    worker,
    "DATABASE_PROVIDER=mysql\nDATABASE_URL=mysql://user:file-secret@worker/db\n",
  );
  await writeFile(migration, "DATABASE_URL=postgres://user:file-secret@migration/db\n");
  const targets = await readDeploymentDatabases(
    [`--server-env=${server}`, `--worker-env=${worker}`, `--migration-env=${migration}`],
    { ...environment, DATABASE_PROVIDER: "mysql" },
  );
  expect(targets.map((target) => target.environment.DATABASE_PROVIDER)).toEqual([
    "postgresql",
    "mysql",
    "postgresql",
  ]);
  await writeFile(worker, "DATABASE_PROVIDER=mysql\n");
  await expect(readDeploymentDatabases([`--worker-env=${worker}`], environment)).rejects.toThrow(
    "Invalid worker database configuration",
  );
});

it.each([["--unknown-env=secret"], ["--server-env=x", "--server-env=y"], ["--server-env="]])(
  "rejects invalid arguments safely %#",
  async (...args) => {
    await expect(readDeploymentDatabases(args, environment)).rejects.toThrow(
      "Invalid database deployment preflight arguments",
    );
  },
);

it("accepts alternate host addresses for the same actual database and does not expose identity", async () => {
  const targets = await readDeploymentDatabases([], environment);
  targets[1].environment.DATABASE_URL = "postgresql://user:secret@container/db";
  const db = database();
  const result = await checkDatabaseDeployment(targets, db);
  expect(result).toEqual({
    status: "ok",
    checks: ["server", "worker", "migration"].map((role) => ({ role, status: "ok" })),
  });
  expect(db.checkDatabaseReadiness).toHaveBeenCalledTimes(3);
  expect(db.disconnect).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(result)).not.toMatch(/instance1|schema1|secret|postgresql/);
});

it.each([
  { ...identity, provider: "mysql" },
  { ...identity, schemaVersion: "different" },
  { ...identity, logicalTarget: "different" },
  { ...identity, instanceId: "different" },
])("rejects actual target mismatch without writes %#", async (different) => {
  const db = database([identity, different, identity]);
  await expect(
    checkDatabaseDeployment(await readDeploymentDatabases([], environment), db),
  ).rejects.toThrow("Database deployment mismatch");
  expect(db.disconnect).toHaveBeenCalledTimes(3);
});

it.each(["connection", "migration", "identity"])(
  "fails closed on %s and disconnects failed target",
  async (reason) => {
    const db = database();
    db.checkDatabaseReadiness.mockRejectedValueOnce(new DatabaseReadinessError(reason));
    await expect(
      checkDatabaseDeployment(await readDeploymentDatabases([], environment), db),
    ).rejects.toThrow(`server database preflight failed (${reason})`);
    expect(db.disconnect).toHaveBeenCalledOnce();
    expect(db.createDatabaseClient).toHaveBeenCalledOnce();
  },
);

it("does not forward raw driver errors", async () => {
  const db = database();
  db.checkDatabaseReadiness.mockRejectedValueOnce(
    new Error("postgresql://user:secret@private-host/db"),
  );
  const result = checkDatabaseDeployment(await readDeploymentDatabases([], environment), db);
  await expect(result).rejects.toThrow("server database preflight failed (configuration)");
  await expect(result).rejects.not.toThrow("secret");
});

it("writes approval only after all three actual database targets match", async () => {
  const db = database();
  db.writeDatabaseDeploymentTarget = vi.fn().mockResolvedValue(undefined);
  await checkDatabaseDeployment(await readDeploymentDatabases([], environment), db, {
    targetFile: "/internal/target.json",
  });
  expect(db.writeDatabaseDeploymentTarget).toHaveBeenCalledExactlyOnceWith(
    "/internal/target.json",
    identity,
  );
  const mismatch = database([identity, { ...identity, instanceId: "other" }, identity]);
  mismatch.writeDatabaseDeploymentTarget = vi.fn();
  await expect(
    checkDatabaseDeployment(await readDeploymentDatabases([], environment), mismatch, {
      targetFile: "/internal/target.json",
    }),
  ).rejects.toThrow("Database deployment mismatch");
  expect(mismatch.writeDatabaseDeploymentTarget).not.toHaveBeenCalled();
});
