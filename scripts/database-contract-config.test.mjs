import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { readContractDatabases } from "../packages/db/src/testing/database-fixture.ts";

const isolated = {
  PHASE25_POSTGRES_URL: "postgresql://test:unused@127.0.0.1:55439/html_share_phase25_guard_pg",
  PHASE25_MYSQL_URL: "mysql://test:unused@127.0.0.1:53319/html_share_phase25_guard_mysql",
};

it("accepts only explicit, separate local Phase 25 database configurations", () => {
  expect(readContractDatabases(isolated).map((db) => db.DATABASE_PROVIDER)).toEqual([
    "postgresql",
    "mysql",
  ]);
});

it.each([
  {},
  { PHASE25_MYSQL_URL: isolated.PHASE25_MYSQL_URL },
  { PHASE25_POSTGRES_URL: isolated.PHASE25_POSTGRES_URL },
  { ...isolated, PHASE25_POSTGRES_URL: "postgresql://test:unused@localhost/production" },
  { ...isolated, PHASE25_MYSQL_URL: "mysql://test:unused@remote.example/html_share_phase25_mysql" },
  { ...isolated, PHASE25_MYSQL_URL: isolated.PHASE25_POSTGRES_URL },
  { ...isolated, PHASE25_MYSQL_URL: "mysql://test:unused@localhost/html_share_phase25_" },
])("refuses missing, mismatched or non-isolated contract targets %#", (environment) => {
  expect(() => readContractDatabases(environment)).toThrow();
});

it("makes the mandatory entry fail before any test runs when one database is missing", () => {
  const environment = { ...process.env, ...isolated };
  delete environment.PHASE25_MYSQL_URL;
  const result = spawnSync(process.execPath, ["scripts/database-contract-check.mjs"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: environment,
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Both PHASE25_POSTGRES_URL and PHASE25_MYSQL_URL");
  expect(`${result.stdout}${result.stderr}`).not.toContain("test:unused");
  expect(result.stdout).not.toContain("RUN");
});
