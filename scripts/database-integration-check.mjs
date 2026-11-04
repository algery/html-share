import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readDatabaseEnv } from "../packages/config/src/database-environment.ts";

try {
  for (const [provider, variable] of [
    ["postgresql", "PHASE24_POSTGRES_URL"],
    ["mysql", "PHASE24_MYSQL_URL"],
  ]) {
    const environment = readDatabaseEnv({
      DATABASE_PROVIDER: provider,
      DATABASE_URL: process.env[variable],
    });
    if (
      !/^html_share_phase24_[a-z0-9_]+$/.test(new URL(environment.DATABASE_URL).pathname.slice(1))
    ) {
      throw new Error("Dedicated html_share_phase24_* databases are required");
    }
  }
  const result = spawnSync(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", "scripts/database-phase24.integration.test.mjs"],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdio: "inherit",
      timeout: 60_000,
    },
  );
  process.exitCode = result.status ?? 1;
} catch {
  console.error(
    "PHASE24_POSTGRES_URL and PHASE24_MYSQL_URL must both identify isolated test databases",
  );
  process.exitCode = 1;
}
