import { readDatabaseEnv } from "../packages/config/src/database-environment.ts";
import { runPrisma } from "./database-command.mjs";

try {
  const environment = readDatabaseEnv(process.env);
  runPrisma(["migrate", "deploy"], environment);
  console.log(`Database migrations deployed (${environment.DATABASE_PROVIDER})`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Database migration failed");
  process.exitCode = 1;
}
