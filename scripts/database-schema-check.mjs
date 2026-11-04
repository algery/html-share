import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareSchemas, readSchema } from "./database-schema-models.mjs";
import { compareMigrations } from "./database-schema-sql.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
async function migrationSql(directory) {
  const migrations = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return (
    await Promise.all(
      migrations.map((name) => readFile(join(directory, name, "migration.sql"), "utf8")),
    )
  ).join("\n");
}

export async function checkDatabaseSchemas(base = root) {
  const pgPath = join(base, "packages/db/prisma");
  const mysqlPath = join(base, "packages/db/prisma-mysql");
  const [pg, mysql, pgSql, mysqlSql] = await Promise.all([
    readSchema(pgPath),
    readSchema(mysqlPath),
    migrationSql(join(pgPath, "migrations")),
    migrationSql(join(mysqlPath, "migrations")),
  ]);
  const issues = [...compareSchemas(pg, mysql), ...compareMigrations(pg, mysql, pgSql, mysqlSql)];
  if (!pg.text.includes('output   = "../src/generated/prisma"'))
    issues.push("PostgreSQL client output changed");
  if (!mysql.text.includes('output   = "../src/generated/prisma-mysql"'))
    issues.push("MySQL client output differs");
  if (!/provider\s*=\s*"postgresql"/.test(pg.text)) issues.push("PostgreSQL datasource differs");
  if (!/provider\s*=\s*"mysql"/.test(mysql.text)) issues.push("MySQL datasource differs");
  const lock = await readFile(join(mysqlPath, "migrations/migration_lock.toml"), "utf8");
  if (!/^provider\s*=\s*"mysql"\s*$/m.test(lock)) issues.push("MySQL migration lock differs");
  return { issues, modelCount: pg.models.size, enumCount: pg.enums.size };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))
) {
  const { issues, modelCount, enumCount } = await checkDatabaseSchemas();
  if (issues.length) {
    console.error(
      `Database schema equivalence FAILED:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
    );
    process.exitCode = 1;
  } else
    console.log(
      `Database schema equivalence PASS: ${modelCount} models, ${enumCount} enums; fields, relations, indexes, CHECKs and physical whitelist verified.`,
    );
}
