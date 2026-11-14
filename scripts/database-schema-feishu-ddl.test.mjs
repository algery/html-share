import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { parseMysqlTables } from "./database-schema-sql.mjs";
import { unsupportedMysqlAlterations } from "./database-schema-constraints.mjs";

const migration = await readFile(
  new URL(
    "../packages/db/prisma-mysql/migrations/20261114000000_feishu_identity/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
it("models the exact nullable DingTalk migration and keeps identity tables binary", () => {
  expect(unsupportedMysqlAlterations(migration)).toEqual([]);
  const tables = parseMysqlTables(migration);
  expect([...tables.keys()]).toEqual(["feishu_identities", "account_contacts"]);
  for (const table of tables.values())
    expect(table.options).toBe("InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin");
  expect(
    tables
      .get("feishu_identities")
      .indexes.has(JSON.stringify([true, ["tenant_id", "identity_key"]])),
  ).toBe(true);
  expect(tables.get("feishu_identities").indexes.has(JSON.stringify([true, ["user_id"]]))).toBe(
    true,
  );
});
it("rejects changes to the reviewed nullable alteration", () => {
  expect(
    unsupportedMysqlAlterations(migration.replace("LONGTEXT NULL", "VARCHAR(191) NULL")),
  ).not.toEqual([]);
  expect(
    unsupportedMysqlAlterations(migration.replace("LONGTEXT NULL", "LONGTEXT NOT NULL")),
  ).not.toEqual([]);
});
