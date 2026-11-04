import type { DatabaseConnection } from "./database-client.js";

interface Migration {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

export class DatabaseReadinessError extends Error {
  constructor(readonly reason: "connection" | "migration" | "identity") {
    super(`Database is not ready (${reason}); check DATABASE_PROVIDER/DATABASE_URL and migrations`);
    this.name = "DatabaseReadinessError";
  }
}

export async function checkDatabaseReadiness(
  connection: DatabaseConnection,
  requiredMigrations: readonly string[],
): Promise<{ provider: DatabaseConnection["provider"]; instanceId: string }> {
  try {
    await connection.client.$connect();
    // Driver adapters can create a pool lazily; verify a real round trip before schema checks.
    await connection.client.$queryRaw`SELECT 1`;
  } catch {
    throw new DatabaseReadinessError("connection");
  }
  let migrations: Migration[];
  try {
    migrations =
      connection.provider === "mysql"
        ? await connection.client.$queryRaw<
            Migration[]
          >`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`
        : await connection.client.$queryRaw<
            Migration[]
          >`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`;
  } catch {
    throw new DatabaseReadinessError("migration");
  }
  const applied = new Set(
    migrations.filter((row) => row.finished_at !== null).map((row) => row.migration_name),
  );
  if (
    requiredMigrations.length === 0 ||
    requiredMigrations.some((name) => !applied.has(name)) ||
    migrations.some((row) => row.finished_at === null && row.rolled_back_at === null)
  )
    throw new DatabaseReadinessError("migration");
  try {
    const identity =
      connection.provider === "mysql"
        ? await connection.client.databaseIdentity.findUnique({ where: { id: 1 } })
        : await connection.client.databaseIdentity.findUnique({ where: { id: 1 } });
    if (
      !identity ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.instanceId)
    ) {
      throw new Error("Missing database identity");
    }
    return { provider: connection.provider, instanceId: identity.instanceId };
  } catch {
    throw new DatabaseReadinessError("identity");
  }
}
