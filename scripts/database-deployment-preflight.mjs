import { pathToFileURL } from "node:url";

import { readDeploymentDatabases } from "./database-deployment-config.mjs";

/** Read-only: a missing identity or migration is an error, never an invitation to initialize it. */
export async function checkDatabaseDeployment(targets, database, options = {}) {
  const identities = [];
  for (const { role, environment } of targets) {
    let connection;
    try {
      connection = database.createDatabaseClient(environment);
      const migrations = await database.readRequiredDatabaseMigrations(connection.provider);
      identities.push(await database.checkDatabaseReadiness(connection, migrations));
    } catch (error) {
      const reason =
        error instanceof database.DatabaseReadinessError ? error.reason : "configuration";
      throw new Error(
        `${role} database preflight failed (${reason}); check configuration and migrations`,
      );
    } finally {
      if (connection) await connection.client.$disconnect().catch(() => undefined);
    }
  }
  database.assertSameDatabaseDeployment(identities);
  if (options.targetFile) {
    try {
      await database.writeDatabaseDeploymentTarget(options.targetFile, identities[0]);
    } catch {
      throw new Error(
        "Cannot write database deployment approval; check target directory permissions",
      );
    }
  }
  return { status: "ok", checks: targets.map(({ role }) => ({ role, status: "ok" })) };
}

export async function runDatabaseDeploymentPreflight(arguments_ = process.argv.slice(2)) {
  try {
    const writeArguments = arguments_.filter((argument) => argument.startsWith("--write-target="));
    if (
      writeArguments.length > 1 ||
      writeArguments.some((argument) => argument === "--write-target=")
    ) {
      throw new Error("Invalid database deployment preflight arguments");
    }
    const targetFile = writeArguments[0]?.slice("--write-target=".length);
    const targets = await readDeploymentDatabases(
      arguments_.filter((argument) => !writeArguments.includes(argument)),
    );
    const database = await import("../packages/db/dist/index.js");
    console.log(JSON.stringify(await checkDatabaseDeployment(targets, database, { targetFile })));
  } catch (error) {
    // Only our controlled diagnostics are safe; dependency/import errors are never forwarded.
    const safeMessages = new Set([
      "Invalid database deployment preflight arguments",
      "Cannot write database deployment approval; check target directory permissions",
      ...["server", "worker", "migration"].flatMap((role) => [
        `Invalid ${role} database configuration; check DATABASE_PROVIDER/DATABASE_URL`,
        `Cannot read ${role} database environment file`,
        ...["connection", "migration", "identity", "configuration"].map(
          (reason) =>
            `${role} database preflight failed (${reason}); check configuration and migrations`,
        ),
      ]),
      ...["provider", "schema", "instance", "logical database"].map(
        (reason) =>
          `Database deployment mismatch (${reason}); align Server, Worker and migration configuration`,
      ),
    ]);
    const message =
      error instanceof Error && safeMessages.has(error.message)
        ? error.message
        : "Database deployment preflight failed; check configuration, build and migrations";
    console.error(message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runDatabaseDeploymentPreflight();
}
