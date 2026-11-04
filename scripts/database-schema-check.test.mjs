import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { checkDatabaseSchemas } from "./database-schema-check.mjs";
import { compareSchemas, parseSchema, readSchema } from "./database-schema-models.mjs";
import { compareChecks } from "./database-schema-checks.mjs";
import { compareMigrations } from "./database-schema-sql.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pgDirectory = join(root, "packages/db/prisma");
const mysqlDirectory = join(root, "packages/db/prisma-mysql");
const pg = await readSchema(pgDirectory),
  mysql = await readSchema(mysqlDirectory);
async function sql(directory) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    await Promise.all(
      entries.map((entry) => readFile(join(directory, entry.name, "migration.sql"), "utf8")),
    )
  ).join("\n");
}
const pgSql = await sql(join(pgDirectory, "migrations"));
const mysqlSql = await sql(join(mysqlDirectory, "migrations"));

test("current schemas and migrations are equivalent without generation or a database", async () => {
  assert.deepEqual((await checkDatabaseSchemas(root)).issues, []);
});

const schemaMutations = {
  "one-sided new model": (text) => `${text}\nmodel Unexpected {\n id Int @id\n}\n`,
  "one-sided new field": (text) =>
    text.replace("model User {", "model User {\n extraField String?"),
  "one-sided field removal": (text) => text.replace(/^\s*homepagePath\s+.*\n/m, ""),
  "one-sided field type": (text) => text.replace(/(totalSize\s+)BigInt/, "$1Int"),
  "nullable field": (text) => text.replace(/(homepagePath\s+)String\?/, "$1String"),
  "business default": (text) => text.replace('@default("organization")', '@default("password")'),
  "field mapping": (text) => text.replace('@map("homepage_path")', '@map("home_path")'),
  "foreign key delete action": (text) => text.replace("onDelete: Restrict", "onDelete: Cascade"),
  "relation referenced field": (text) => text.replace("references: [id]", "references: [tenantId]"),
  "compound uniqueness": (text) =>
    text.replace("@@unique([projectId, revisionNumber])", "@@unique([projectId])"),
  "missing logical uniqueness": (text) =>
    text.replace("@@unique([storageKeyDigest])", "@@index([storageKeyDigest])"),
  "enum member": (text) => text.replace("  REVOKED\n", "  REVOKED\n  REMOVED\n"),
  "path truncation": (text) =>
    text.replace(/(relativePath\s+String[^\n]*)@db.LongText/, "$1@db.VarChar(255)"),
  "UUID physical type": (text) => text.replace("@db.Char(36)", "@db.Char(32)"),
  "timestamp precision": (text) => text.replace("@db.DateTime(3)", "@db.DateTime(0)"),
  "exposed physical helper": (text) => text.replace(/(appKeyDigest[^\n]*)@ignore/, "$1"),
  "unknown ignored field": (text) =>
    text.replace("model User {", "model User {\n rogueField Int? @ignore"),
};
for (const [name, mutate] of Object.entries(schemaMutations)) {
  test(`rejects schema drift: ${name}`, () => {
    const text = mutate(mysql.text);
    assert.notEqual(text, mysql.text, "mutation must affect the fixture");
    assert.notDeepEqual(compareSchemas(pg, parseSchema(text)), [], "drift must be detected");
  });
}

const sqlMutations = {
  "dropped core table": (text) => `${text}\nDROP TABLE \`upload_files\`;`,
  "generated business field": (text) =>
    text.replace(
      "`homepage_path` LONGTEXT NULL",
      "`homepage_path` LONGTEXT GENERATED ALWAYS AS ('forced.html') VIRTUAL",
    ),
  "unknown index table": (text) => `${text}\nCREATE INDEX \`rogue\` ON \`unknown\`(\`id\`);`,
  "conditional executable SQL": (text) => `${text}\n/*!80000 DROP TABLE \`upload_files\` */;`,
  "extra table collation override": (text) =>
    text.replace(
      "COLLATE utf8mb4_0900_bin;",
      "COLLATE utf8mb4_0900_bin COLLATE utf8mb4_unicode_ci;",
    ),
  "truncated business data": (text) => `${text}\nTRUNCATE TABLE \`upload_files\`;`,
  "deleted business data": (text) => `${text}\nDELETE FROM \`users\`;`,
  "modified business data": (text) => `${text}\nUPDATE \`users\` SET \`status\`='DISABLED';`,
  "renamed core table": (text) => `${text}\nRENAME TABLE \`users\` TO \`removed_users\`;`,
  "unexpected business seed": (text) => `${text}\nINSERT INTO \`users\`(\`id\`) VALUES ('rogue');`,
  "column collation override": (text) =>
    text.replace(
      "`relative_path` LONGTEXT NOT NULL",
      "`relative_path` LONGTEXT COLLATE utf8mb4_unicode_ci NOT NULL",
    ),
  "unsigned byte range": (text) =>
    text.replace("`size` BIGINT NOT NULL", "`size` BIGINT UNSIGNED NOT NULL"),
  "column implicit update": (text) =>
    text.replace(
      "`updated_at` DATETIME(3) NOT NULL",
      "`updated_at` DATETIME(3) NOT NULL ON UPDATE CURRENT_TIMESTAMP(3)",
    ),
  "unsafe SQL session mode": (text) => `${text}\nSET sql_mode='';`,
  "missing SQL column": (text) => text.replace("`homepage_path` LONGTEXT NULL,", ""),
  "extra SQL column": (text) =>
    text.replace("CREATE TABLE `tenants` (", "CREATE TABLE `tenants` (`rogue` INTEGER,"),
  "SQL nullable change": (text) =>
    text.replace("`homepage_path` LONGTEXT NULL", "`homepage_path` LONGTEXT NOT NULL"),
  "SQL type change": (text) => text.replace("`total_size` BIGINT", "`total_size` INTEGER"),
  "SQL default change": (text) => text.replace("DEFAULT ('organization')", "DEFAULT ('password')"),
  "missing SQL enum default": (text) => text.replace("DEFAULT 'ACTIVE'", ""),
  "missing boolean default": (text) => text.replace("DEFAULT false", ""),
  "missing numeric default": (text) => text.replace("DEFAULT 0", ""),
  "missing JSON default": (text) => text.replace("DEFAULT ('[]')", ""),
  "missing timestamp default": (text) => text.replace("DEFAULT CURRENT_TIMESTAMP(3)", ""),
  "SQL enum default change": (text) => text.replace("DEFAULT 'ACTIVE'", "DEFAULT 'REVOKED'"),
  "unexpected nullable default": (text) =>
    text.replace(
      "`homepage_path` LONGTEXT NULL",
      "`homepage_path` LONGTEXT NULL DEFAULT ('index.html')",
    ),
  "unexpected required default": (text) =>
    text.replace("`name` LONGTEXT NOT NULL", "`name` LONGTEXT NOT NULL DEFAULT ('rogue')"),
  "unexpected client UUID default": (text) =>
    text.replace("`id` CHAR(36) NOT NULL", "`id` CHAR(36) NOT NULL DEFAULT (UUID())"),
  "missing identity UUID default": (text) => text.replace("DEFAULT (UUID())", ""),
  "changed identity UUID default": (text) => text.replace("DEFAULT (UUID())", "DEFAULT ('fixed')"),
  "missing identity initialization": (text) =>
    text.replace(/INSERT INTO `database_identity`[^;]+;/, ""),
  "changed identity initialization": (text) =>
    text.replace("VALUES (1, CURRENT_TIMESTAMP(3))", "VALUES (2, CURRENT_TIMESTAMP(3))"),
  "SQL enum change": (text) =>
    text.replace("ENUM('ACTIVE', 'REVOKED')", "ENUM('ACTIVE', 'REVOKED', 'NEW')"),
  "extra inline uniqueness": (text) =>
    text.replace("`expires_at` DATETIME(3) NOT NULL", "`expires_at` DATETIME(3) NOT NULL UNIQUE"),
  "dropped primary key": (text) => `${text}\nALTER TABLE \`mcp_tokens\` DROP PRIMARY KEY;`,
  "ALTER default drift": (text) =>
    `${text}\nALTER TABLE \`mcp_tokens\` ALTER COLUMN \`status\` SET DEFAULT 'REVOKED';`,
  "extra SQL uniqueness": (text) =>
    text.replace("PRIMARY KEY (`id`)", "UNIQUE INDEX `rogue`(`expires_at`), PRIMARY KEY (`id`)"),
  "extra SQL unique key": (text) =>
    text.replace("PRIMARY KEY (`id`)", "UNIQUE KEY `rogue` (`expires_at`), PRIMARY KEY (`id`)"),
  "extra named UNIQUE constraint": (text) =>
    text.replace(
      "PRIMARY KEY (`id`)",
      "CONSTRAINT `rogue` UNIQUE (`expires_at`), PRIMARY KEY (`id`)",
    ),
  "extra ALTER uniqueness": (text) =>
    `${text}\nALTER TABLE \`mcp_tokens\` ADD UNIQUE (\`expires_at\`);`,
  "extra CREATE uniqueness": (text) =>
    `${text}\nCREATE UNIQUE INDEX \`rogue\` ON \`mcp_tokens\`(\`expires_at\`);`,
  "extra SQL foreign key": (text) =>
    `${text}\nALTER TABLE \`audit_logs\` ADD CONSTRAINT \`rogue\` FOREIGN KEY (\`actor_user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE;`,
  "extra SQL primary column": (text) =>
    text.replace("PRIMARY KEY (`id`)", "PRIMARY KEY (`id`, `expires_at`)"),
  "missing FK": (text) => text.replace(/ALTER TABLE `users` ADD CONSTRAINT[^;]+;/, ""),
  "wrong FK owner table": (text) =>
    text.replace("ALTER TABLE `users` ADD CONSTRAINT", "ALTER TABLE `audit_logs` ADD CONSTRAINT"),
  "missing scoped path uniqueness": (text) =>
    text.replace(
      "UNIQUE INDEX `upload_files_upload_task_id_relative_path_digest_key`",
      "INDEX `upload_files_upload_task_id_relative_path_digest_key`",
    ),
  "missing historical index": (text) =>
    text.replace(/CREATE INDEX `upload_tasks_status_claimed_at_expires_at_idx`[^;]+;/, ""),
  "wrong digest algorithm": (text) => text.replace("USING utf8mb4), 256)", "USING utf8mb4), 224)"),
  "wrong active task states": (text) =>
    text.replace(
      "CASE WHEN `status` IN ('PREPARED', 'PROCESSING')",
      "CASE WHEN `status` IN ('PREPARED')",
    ),
  "CHECK string literal case": (text) =>
    text.replace("`access_mode` = 'organization'", "`access_mode` = 'ORGANIZATION'"),
  "CHECK owner table": (text) =>
    text.replace(
      "ALTER TABLE `demo_projects` ADD CONSTRAINT `demo_projects_password_access_check`",
      "ALTER TABLE `upload_tasks` ADD CONSTRAINT `demo_projects_password_access_check`",
    ),
  "extra unnamed CHECK": (text) =>
    `${text}\nALTER TABLE \`demo_projects\` ADD CHECK (\`password_version\` > 0);`,
  "disabled CHECK": (text) => text.replace("CHECK (`id` = 1)", "CHECK (`id` = 1) NOT ENFORCED"),
  "dropped CHECK": (text) =>
    `${text}\nALTER TABLE \`demo_projects\` DROP CHECK \`demo_projects_password_access_check\`;`,
  "extra CHECK": (text) =>
    `${text}\nALTER TABLE \`demo_projects\` ADD CONSTRAINT \`rogue\` CHECK (\`password_version\` > 0);`,
  "wrong CHECK": (text) => text.replace("`password_version` > 0", "`password_version` >= 0"),
  "wrong CHECK boolean grouping": (text) =>
    text.replace(
      "`password_hash` IS NOT NULL AND CHAR_LENGTH",
      "`password_hash` IS NOT NULL OR CHAR_LENGTH",
    ),
  "wrong storage engine": (text) => text.replace("ENGINE=InnoDB", "ENGINE=MyISAM"),
  "case insensitive comparison": (text) =>
    text.replace("COLLATE utf8mb4_0900_bin", "COLLATE utf8mb4_unicode_ci"),
  "missing UTC": (text) => text.replace("SET time_zone = '+00:00';", ""),
};
for (const [name, mutate] of Object.entries(sqlMutations)) {
  test(`rejects migration drift: ${name}`, () => {
    const text = mutate(mysqlSql);
    assert.notEqual(text, mysqlSql, "mutation must affect the fixture");
    assert.notDeepEqual(compareMigrations(pg, mysql, pgSql, text), [], "drift must be detected");
  });
}

for (const [name, mutate] of Object.entries({
  "missing PostgreSQL identity seed": (text) =>
    text.replace(/INSERT INTO "database_identity"[^;]+;/, ""),
  "missing PostgreSQL identity UUID default": (text) =>
    text.replace(
      '"instance_id" UUID NOT NULL DEFAULT gen_random_uuid()',
      '"instance_id" UUID NOT NULL',
    ),
})) {
  test(`rejects metadata drift: ${name}`, () => {
    const text = mutate(pgSql);
    assert.notEqual(text, pgSql, "mutation must affect the fixture");
    assert.notDeepEqual(compareMigrations(pg, mysql, text, mysqlSql), []);
  });
}

test("CHECK syntax normalization preserves escaped literals and grouping", () => {
  const check = (table, value) => `ALTER TABLE ${table} ADD CONSTRAINT sample CHECK (${value});`;
  const pgCheck = check('"sample_table"', `"mode" = 'a''b (OR) c' AND length("mode") > 0`);
  const mysqlCheck = check("`sample_table`", "`mode` = 'a''b (OR) c' AND CHAR_LENGTH(`mode`) > 0");
  assert.deepEqual(compareChecks(pgCheck, mysqlCheck), []);
  assert.notDeepEqual(compareChecks(pgCheck, mysqlCheck.replace("(OR)", "(or)")), []);
  assert.notDeepEqual(compareChecks(pgCheck, mysqlCheck.replace("a''b", "a''B")), []);
});

test("rejects unmodeled PostgreSQL statements after the additive metadata migration", () => {
  for (const statement of [
    'DROP TABLE "upload_files";',
    'TRUNCATE "users";',
    "UPDATE \"users\" SET status='DISABLED';",
  ]) {
    assert.notDeepEqual(compareMigrations(pg, mysql, `${pgSql}\n${statement}`, mysqlSql), []);
  }
});

test("rejects unreviewed PostgreSQL metadata column changes", () => {
  for (const sql of [
    pgSql.replace('"instance_id" UUID NOT NULL', '"instance_id" TEXT NOT NULL'),
    pgSql.replace('"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,', ""),
  ]) {
    assert.notEqual(sql, pgSql);
    assert.notDeepEqual(compareMigrations(pg, mysql, sql, mysqlSql), []);
  }
});
