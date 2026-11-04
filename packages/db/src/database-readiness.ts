import { createHash } from "node:crypto";

import type { DatabaseConnection } from "./database-client.js";
import { readRequiredDatabaseMigrations, type DatabaseMigration } from "./database-migrations.js";

interface Migration {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

export interface DatabaseDeploymentIdentity {
  provider: DatabaseConnection["provider"];
  instanceId: string;
  schemaVersion: string;
  logicalTarget: string;
}

export class DatabaseReadinessError extends Error {
  constructor(readonly reason: "connection" | "migration" | "identity") {
    super(`Database is not ready (${reason}); check DATABASE_PROVIDER/DATABASE_URL and migrations`);
    this.name = "DatabaseReadinessError";
  }
}

export async function checkDatabaseReadiness(
  connection: DatabaseConnection,
  requiredMigrations: readonly (DatabaseMigration | string)[],
): Promise<DatabaseDeploymentIdentity> {
  let logicalTarget: string;
  try {
    await connection.client.$connect();
    // Driver pools may be lazy: a connection alone does not prove SQL readiness.
    const target =
      connection.provider === "mysql"
        ? await connection.client.$queryRaw<
            {
              database_name: string | null;
              schema_name: string | null;
              server_instance: string | null;
            }[]
          >`SELECT DATABASE() AS database_name, DATABASE() AS schema_name, @@server_uuid AS server_instance`
        : await connection.client.$queryRaw<
            {
              database_name: string | null;
              schema_name: string | null;
              server_instance: string | null;
            }[]
          >`SELECT current_database() AS database_name, current_schema() AS schema_name,
              (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS server_instance`;
    const row = target[0];
    if (!row?.database_name || !row.schema_name || !row.server_instance)
      throw new DatabaseReadinessError("connection");
    logicalTarget = createHash("sha256")
      // Logical dumps copy database_identity, but never the engine's own identity.
      .update(JSON.stringify([row.server_instance, row.database_name, row.schema_name]))
      .digest("hex");
  } catch {
    throw new DatabaseReadinessError("connection");
  }
  let schemaVersion: string;
  try {
    const migrations = await connection.client.$queryRaw<Migration[]>`
      SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations`;
    const delivered = requiredMigrations.some((entry) => typeof entry === "string")
      ? await readRequiredDatabaseMigrations(connection.provider)
      : [];
    const required = requiredMigrations.map((entry) =>
      typeof entry === "string" ? delivered.find((migration) => migration.name === entry) : entry,
    );
    const active = migrations.filter((row) => row.rolled_back_at === null);
    const applied = active.filter((row) => row.finished_at !== null);
    if (
      required.length === 0 ||
      required.some(
        (migration) =>
          !migration ||
          !applied.some(
            (row) => row.migration_name === migration.name && row.checksum === migration.checksum,
          ),
      ) ||
      active.some((row) => row.finished_at === null) ||
      applied.some((row) => !/^[a-f0-9]{64}$/.test(row.checksum)) ||
      new Set(applied.map((row) => row.migration_name)).size !== applied.length
    )
      throw new DatabaseReadinessError("migration");
    schemaVersion = createHash("sha256")
      .update(
        JSON.stringify(
          applied
            .map((row) => [row.migration_name, row.checksum])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        ),
      )
      .digest("hex");
  } catch {
    throw new DatabaseReadinessError("migration");
  }
  try {
    const identity =
      connection.provider === "mysql"
        ? await connection.client.databaseIdentity.findUnique({ where: { id: 1 } })
        : await connection.client.databaseIdentity.findUnique({ where: { id: 1 } });
    if (
      !identity ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.instanceId)
    ) {
      throw new DatabaseReadinessError("identity");
    }
    return {
      provider: connection.provider,
      instanceId: identity.instanceId,
      schemaVersion,
      logicalTarget,
    };
  } catch {
    throw new DatabaseReadinessError("identity");
  }
}

export function assertSameDatabaseDeployment(
  identities: readonly DatabaseDeploymentIdentity[],
): void {
  const first = identities[0];
  if (!first || identities.some((identity) => identity.provider !== first.provider)) {
    throw new Error(
      "Database deployment mismatch (provider); align Server, Worker and migration configuration",
    );
  }
  if (identities.some((identity) => identity.logicalTarget !== first.logicalTarget)) {
    throw new Error(
      "Database deployment mismatch (logical database); align Server, Worker and migration configuration",
    );
  }
  if (identities.some((identity) => identity.schemaVersion !== first.schemaVersion)) {
    throw new Error(
      "Database deployment mismatch (schema); align Server, Worker and migration configuration",
    );
  }
  if (identities.some((identity) => identity.instanceId !== first.instanceId)) {
    throw new Error(
      "Database deployment mismatch (instance); align Server, Worker and migration configuration",
    );
  }
}
