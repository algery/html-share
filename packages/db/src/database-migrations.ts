import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import type { DatabaseConnection } from "./database-client.js";

export interface DatabaseMigration {
  name: string;
  checksum: string;
}

/** Read the delivered migration history without changing database state. */
export async function readRequiredDatabaseMigrations(
  provider: DatabaseConnection["provider"],
): Promise<DatabaseMigration[]> {
  const directory = provider === "mysql" ? "prisma-mysql" : "prisma";
  const root = new URL(`../${directory}/migrations/`, import.meta.url);
  const entries = await readdir(root, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => ({
        name: entry.name,
        checksum: createHash("sha256")
          .update(await readFile(new URL(`${entry.name}/migration.sql`, root)))
          .digest("hex"),
      })),
  );
}
