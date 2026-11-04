import { readdir } from "node:fs/promises";

import type { DatabaseEnvironment } from "@html-share/config";
import { createDatabaseClient } from "./database-client.js";
import { DatabaseOperationError } from "./database-errors.js";
import { checkDatabaseReadiness } from "./database-readiness.js";
import { createDatabaseRepositories } from "./database-repositories.js";

export async function openDatabaseRepositories(
  environment: DatabaseEnvironment,
  options: NonNullable<Parameters<typeof createDatabaseRepositories>[1]> = {},
) {
  const connection = createDatabaseClient(environment);
  try {
    const directory = connection.provider === "mysql" ? "prisma-mysql" : "prisma";
    const entries = await readdir(new URL(`../${directory}/migrations/`, import.meta.url), {
      withFileTypes: true,
    });
    await checkDatabaseReadiness(
      connection,
      entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    );
    return {
      ...createDatabaseRepositories(connection, options),
      close: () => connection.client.$disconnect(),
    };
  } catch {
    await connection.client.$disconnect().catch(() => undefined);
    throw new DatabaseOperationError("startup");
  }
}
