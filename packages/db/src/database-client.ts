import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaPg } from "@prisma/adapter-pg";
import { readDatabaseEnv, type DatabaseEnvironment } from "@html-share/config";

import { PrismaClient as PostgresClient } from "./generated/prisma/client.js";
import { PrismaClient as MysqlClient } from "./generated/prisma-mysql/client.js";
import { mysqlConnectionOptions } from "./mysql-connection-options.js";

export type DatabaseConnection =
  { provider: "postgresql"; client: PostgresClient } | { provider: "mysql"; client: MysqlClient };

export function createDatabaseClient(environment: DatabaseEnvironment): DatabaseConnection {
  const configuration = readDatabaseEnv({ ...environment });
  if (configuration.DATABASE_PROVIDER === "postgresql") {
    return {
      provider: "postgresql",
      client: new PostgresClient({
        adapter: new PrismaPg({
          connectionString: configuration.DATABASE_URL,
          max: 5,
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 10_000,
        }),
      }),
    };
  }
  return {
    provider: "mysql",
    client: new MysqlClient({
      adapter: new PrismaMariaDb(mysqlConnectionOptions(configuration.DATABASE_URL)),
    }),
  };
}
