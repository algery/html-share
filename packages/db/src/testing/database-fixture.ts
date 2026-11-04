import { readDatabaseEnv } from "@html-share/config";

import { createDatabaseClient } from "../database-client.js";

export type ContractDatabaseProvider = "postgresql" | "mysql";

/** Shared by the mandatory runner and fixtures before opening any connection. */
export function readContractDatabases(environment: NodeJS.ProcessEnv = process.env) {
  return (["postgresql", "mysql"] as const).map((provider) => {
    const variable = provider === "mysql" ? "PHASE25_MYSQL_URL" : "PHASE25_POSTGRES_URL";
    const configuration = readDatabaseEnv({
      DATABASE_PROVIDER: provider,
      DATABASE_URL: environment[variable],
    });
    const target = new URL(configuration.DATABASE_URL);
    if (
      !/^html_share_phase25_[a-z0-9_]+$/.test(target.pathname.slice(1)) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
    ) {
      throw new Error("Phase 25 contracts require isolated local html_share_phase25_* databases");
    }
    return configuration;
  });
}

/** No generated-client casts: preserve the provider/client discriminated union. */
export function createDatabaseFixture(provider: ContractDatabaseProvider) {
  const configuration = readContractDatabases().find(
    (database) => database.DATABASE_PROVIDER === provider,
  );
  if (!configuration) throw new Error("Both Phase 25 contract databases are required");
  return createDatabaseClient(configuration);
}
