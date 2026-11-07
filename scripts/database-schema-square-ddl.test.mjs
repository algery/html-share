import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { normalizeSquareMysqlDdl } from "./database-schema-square-ddl.mjs";
import { unsupportedMysqlStatements } from "./database-schema-statements.mjs";

const migration = await readFile(
  new URL(
    "../packages/db/prisma-mysql/migrations/20261107000000_project_square/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
it("models only the exact reviewed guarded unionId column addition", () => {
  const normalized = normalizeSquareMysqlDdl(migration);
  expect(normalized).toContain("ALTER TABLE `users` ADD COLUMN `dingtalk_union_id`");
  expect(normalized).not.toContain("PREPARE");
  expect(unsupportedMysqlStatements(normalized)).toEqual([]);
});
it("leaves altered dynamic DDL unsupported instead of interpreting it", () => {
  for (const sql of [
    migration.replace("table_name = 'users'", "table_name = 'tokens'"),
    migration.replace("VARCHAR(191)", "VARCHAR(20)"),
    migration.replace("'SELECT 1'", "'DROP TABLE users'"),
    migration + "\nPREPARE rogue FROM @rogue; EXECUTE rogue;",
  ])
    expect(unsupportedMysqlStatements(normalizeSquareMysqlDdl(sql)).length).toBeGreaterThan(0);
});
