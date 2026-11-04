import { readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { readDatabaseEnv } from "../packages/config/src/database-environment.ts";
import { checkDatabaseReadiness, createDatabaseClient } from "../packages/db/dist/index.js";

let connection;
try {
  const environment = readDatabaseEnv(process.env);
  const directory = environment.DATABASE_PROVIDER === "mysql" ? "prisma-mysql" : "prisma";
  const entries = await readdir(
    new URL(`../packages/db/${directory}/migrations/`, import.meta.url),
    {
      withFileTypes: true,
    },
  );
  const migrations = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  connection = createDatabaseClient(environment);
  await checkDatabaseReadiness(connection, migrations);
  if (process.argv.includes("--write-check")) {
    const name = new URL(environment.DATABASE_URL).pathname.slice(1);
    if (
      process.env.DATABASE_TEST_ISOLATED !== "1" ||
      !/^html_share_phase24_[a-z0-9_]+$/.test(name)
    ) {
      throw new Error(
        "Write checks require DATABASE_TEST_ISOLATED=1 and a dedicated html_share_phase24_* database",
      );
    }
    const stateDigest = `phase24-${randomUUID()}`;
    const data = { stateDigest, audience: "APP", returnPath: "/demos", expiresAt: new Date() };
    // The fixture is removed in the same transaction, leaving no persistent test data.
    if (connection.provider === "mysql") {
      await connection.client.$transaction(async (tx) => {
        const state = await tx.authState.create({ data: { ...data, audience: "APP" } });
        const stored = await tx.authState.findUniqueOrThrow({ where: { id: state.id } });
        if (stored.stateDigest !== stateDigest) throw new Error("Fixture read mismatch");
        await tx.authState.delete({ where: { id: state.id } });
      });
    } else {
      await connection.client.$transaction(async (tx) => {
        const state = await tx.authState.create({ data: { ...data, audience: "APP" } });
        const stored = await tx.authState.findUniqueOrThrow({ where: { id: state.id } });
        if (stored.stateDigest !== stateDigest) throw new Error("Fixture read mismatch");
        await tx.authState.delete({ where: { id: state.id } });
      });
    }
  }
  console.log(
    `Database ${environment.DATABASE_PROVIDER}: ready${process.argv.includes("--write-check") ? "; isolated write/read/delete passed" : ""}`,
  );
} catch {
  console.error(
    "Database smoke check failed; verify DATABASE_PROVIDER/DATABASE_URL, migration state and isolation settings",
  );
  process.exitCode = 1;
} finally {
  if (connection) await connection.client.$disconnect();
}
