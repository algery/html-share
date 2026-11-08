import { normalizeSquareMysqlDdl, unionColumnDefinition } from "./database-schema-square-ddl.mjs";
import { sqlTokens } from "./database-schema-tokens.mjs";
import { compareReviewedSql } from "./database-schema-reviewed-sql.mjs";
import {
  unsupportedMysqlStatements,
  unsupportedMysqlColumn,
  unsupportedPostgresIdentityTail,
} from "./database-schema-statements.mjs";
import {
  collectMysqlKeys,
  foreignKeys,
  foreignKeySignature,
  unsupportedMysqlAlterations,
  mysqlTokenExpiryAlter,
} from "./database-schema-constraints.mjs";
import { compareDefault, compareIdentityInitialization } from "./database-schema-defaults.mjs";
import { compareChecks } from "./database-schema-checks.mjs";
import {
  MYSQL_HASH_FIELDS,
  MYSQL_ACTIVE_FIELD,
  databaseName,
  nativeType,
} from "./database-schema-models.mjs";

export function splitSqlList(text) {
  const parts = [];
  let depth = 0,
    quote = null,
    start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote && text[index - 1] !== "\\") quote = null;
      continue;
    }
    if (["'", '"', "`"].includes(char)) {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

function unquote(text) {
  return text.replace(/[`"\s]/g, "");
}
function list(text) {
  return splitSqlList(text).map(unquote);
}
function signature(unique, fields) {
  return JSON.stringify([unique, fields]);
}

export function parseMysqlTables(sql) {
  const tables = new Map();
  for (const match of sql.matchAll(
    /CREATE TABLE (?:IF NOT EXISTS )?`(\w+)` \(([\s\S]*?)\) ENGINE=([^;]+);/g,
  )) {
    const fields = new Map(),
      indexes = new Set();
    let primary = [];
    for (const definition of splitSqlList(match[2])) {
      const field = /^`(\w+)`\s+([\s\S]*)$/.exec(definition);
      if (field) {
        fields.set(field[1], field[2]);
        const qualifiers = sqlTokens(field[2]);
        if (qualifiers.includes("unique")) indexes.add(signature(true, [field[1]]));
        if (qualifiers.includes("primary")) primary = [field[1]];
        continue;
      }
      const key = /^PRIMARY KEY \((.*)\)$/.exec(definition);
      if (key) primary = list(key[1]);
      const index = /^(UNIQUE )?INDEX `[^`]+`\s*\((.*)\)$/.exec(definition);
      if (index) indexes.add(signature(Boolean(index[1]), list(index[2])));
    }
    tables.set(match[1], { fields, indexes, primary, options: match[3] });
  }
  for (const match of sql.matchAll(/CREATE (UNIQUE )?INDEX `[^`]+` ON `(\w+)`\s*\(([^;]+)\);/g)) {
    tables.get(match[2])?.indexes.add(signature(Boolean(match[1]), list(match[3])));
  }
  for (const match of sql.matchAll(/ALTER TABLE `(\w+)` ADD COLUMN `(\w+)` ([^;]+);/g)) {
    tables.get(match[1])?.fields.set(match[2], match[3]);
  }
  if (sql.includes(mysqlTokenExpiryAlter)) {
    tables.get("mcp_tokens")?.fields.set("expires_at", "DATETIME(3) NULL");
  }
  collectMysqlKeys(sql, tables);
  return tables;
}

export function compareMigrations(pgSchema, mysqlSchema, postgresSql, mysqlSql) {
  const reviewedIssues = compareReviewedSql(postgresSql, mysqlSql);
  mysqlSql = normalizeSquareMysqlDdl(mysqlSql);
  const issues = [
    ...reviewedIssues,
    ...unsupportedMysqlStatements(mysqlSql),
    ...unsupportedMysqlAlterations(mysqlSql),
    ...unsupportedPostgresIdentityTail(postgresSql),
  ];
  const tables = parseMysqlTables(mysqlSql);
  const expectedIndexes = new Map(),
    expectedForeignKeys = [];
  const expectedTables = [...mysqlSchema.models.values()]
    .map((m) => databaseName(m.name, m.attributes.join(" ")))
    .sort();
  if (JSON.stringify([...tables.keys()].sort()) !== JSON.stringify(expectedTables))
    issues.push("MySQL SQL table set differs from schema");
  for (const model of mysqlSchema.models.values()) {
    const tableName = databaseName(model.name, model.attributes.join(" "));
    const table = tables.get(tableName);
    if (!table) continue;
    const indexes = new Set();
    expectedIndexes.set(tableName, indexes);
    const primary = [...model.fields]
      .filter(([, field]) => /@id\b/.test(field.attributes))
      .map(([name, field]) => databaseName(name, field.attributes));
    const compoundPrimary = model.attributes.find((attribute) => attribute.startsWith("@@id("));
    if (compoundPrimary)
      primary.push(
        .../\[([^\]]+)\]/
          .exec(compoundPrimary)[1]
          .split(",")
          .map((name) => databaseName(name.trim(), model.fields.get(name.trim()).attributes)),
      );
    if (JSON.stringify(table.primary) !== JSON.stringify(primary))
      issues.push(`${tableName} SQL primary key differs`);
    if (
      table.options.trim().replace(/\s+/g, " ").toLowerCase() !==
      "innodb default character set utf8mb4 collate utf8mb4_0900_bin"
    )
      issues.push(`${tableName} requires InnoDB/utf8mb4_0900_bin`);
    const scalars = [...model.fields].filter(
      ([, field]) => !mysqlSchema.models.has(field.type.replace(/[?[\]]/g, "")),
    );
    const columns = scalars.map(([name, field]) => databaseName(name, field.attributes)).sort();
    if (JSON.stringify([...table.fields.keys()].sort()) !== JSON.stringify(columns))
      issues.push(`${tableName} SQL column set differs`);
    for (const [name, field] of scalars) {
      const column = databaseName(name, field.attributes),
        definition = table.fields.get(column);
      if (!definition) continue;
      if (
        unsupportedMysqlColumn(definition) &&
        !(
          tableName === "users" &&
          column === "dingtalk_union_id" &&
          definition === unionColumnDefinition
        )
      )
        issues.push(`${tableName}.${column} has unsupported physical qualifiers`);
      const expectedType =
        nativeType(field) ??
        { Int: "INTEGER", BigInt: "BIGINT", Boolean: "BOOLEAN", Json: "JSON" }[
          field.type.replace("?", "")
        ];
      if (expectedType && !definition.toLowerCase().startsWith(expectedType.toLowerCase()))
        issues.push(`${tableName}.${column} SQL type differs`);
      const generated = /@ignore\b/.test(field.attributes);
      if (!generated && /\bNOT NULL\b/.test(definition) === field.type.endsWith("?"))
        issues.push(`${tableName}.${column} SQL NULL semantics differ`);
      if (/@unique\b/.test(field.attributes)) indexes.add(signature(true, [column]));
      if (!compareDefault(model, name, field, definition, mysqlSchema.enums))
        issues.push(`${tableName}.${column} SQL default differs`);
      const enumValues = mysqlSchema.enums
        .get(field.type.replace("?", ""))
        ?.filter((line) => !line.startsWith("@@"));
      if (
        enumValues &&
        !definition.startsWith(`ENUM(${enumValues.map((value) => `'${value}'`).join(", ")})`)
      )
        issues.push(`${tableName}.${column} SQL enum differs`);
    }
    for (const attribute of model.attributes) {
      const index = /^@@(unique|index)\(\[([^\]]+)\]/.exec(attribute);
      if (index) {
        const columns = index[2].split(",").map((name) => {
          const field = model.fields.get(name.trim());
          return field ? databaseName(name.trim(), field.attributes) : name.trim();
        });
        indexes.add(signature(index[1] === "unique", columns));
      }
    }
    for (const [helper, source] of Object.entries(MYSQL_HASH_FIELDS[model.name] ?? {})) {
      if (!model.fields.has(helper) || !model.fields.has(source)) continue;
      const helperColumn = databaseName(helper, model.fields.get(helper).attributes);
      const sourceColumn = databaseName(source, model.fields.get(source).attributes);
      const expression = `BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(CONVERT(\`${sourceColumn}\` USING utf8mb4), 256))) VIRTUAL`;
      if (table.fields.get(helperColumn) !== expression)
        issues.push(`${tableName}.${helperColumn} SHA-256 expression differs`);
    }
    for (const [, field] of model.fields) {
      const relation = /@relation\((.*)\)/.exec(field.attributes)?.[1];
      if (!relation || !/fields:/.test(relation)) continue;
      const from = /fields:\s*\[([^\]]+)\]/
        .exec(relation)?.[1]
        .split(",")
        .map((part) => databaseName(part.trim(), model.fields.get(part.trim()).attributes));
      const target = mysqlSchema.models.get(field.type.replace("?", ""));
      const to = /references:\s*\[([^\]]+)\]/
        .exec(relation)?.[1]
        .split(",")
        .map((part) => databaseName(part.trim(), target.fields.get(part.trim()).attributes));
      const targetTable = databaseName(target.name, target.attributes.join(" "));
      const action = /onDelete:\s*(\w+)/
        .exec(relation)?.[1]
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toUpperCase();
      const update = /onUpdate:\s*(\w+)/.exec(relation)?.[1] ?? "Cascade";
      expectedForeignKeys.push(
        foreignKeySignature(
          tableName,
          from,
          targetTable,
          to,
          action ?? "RESTRICT",
          update.replace(/([a-z])([A-Z])/g, "$1 $2"),
        ),
      );
    }
  }
  // Include indexes present in applied PostgreSQL migrations but absent from PSL.
  for (const match of postgresSql.matchAll(
    /CREATE (UNIQUE )?INDEX(?: IF NOT EXISTS)? ["\w]+\s+ON ["`]?([\w]+)["`]?\s*\(([^;]+?)\)(?:;| WHERE)/g,
  )) {
    const [, unique, tableName, rawColumns] = match;
    if (match[0].endsWith(" WHERE")) continue; // independently verified partial constraint below
    const pgModel = [...pgSchema.models.values()].find(
      (model) => databaseName(model.name, model.attributes.join(" ")) === tableName,
    );
    if (!pgModel) {
      issues.push(`${tableName} PostgreSQL migration table missing from model`);
      continue;
    }
    const mysqlModel = mysqlSchema.models.get(pgModel.name);
    const helpers = MYSQL_HASH_FIELDS[pgModel.name] ?? {};
    const columns = list(rawColumns.replace(/\s+DESC/gi, "")).map((column) => {
      const source = [...pgModel.fields].find(
        ([name, field]) => databaseName(name, field.attributes) === column,
      )?.[0];
      const helper = Object.entries(helpers).find(([, field]) => field === source)?.[0];
      return helper ? databaseName(helper, mysqlModel.fields.get(helper).attributes) : column;
    });
    expectedIndexes.get(tableName)?.add(signature(Boolean(unique), columns));
  }
  for (const [tableName, indexes] of expectedIndexes) {
    if (
      JSON.stringify([...tables.get(tableName).indexes].sort()) !==
      JSON.stringify([...indexes].sort())
    )
      issues.push(`${tableName} SQL index/unique constraint set differs`);
  }
  if (JSON.stringify(foreignKeys(mysqlSql)) !== JSON.stringify(expectedForeignKeys.sort()))
    issues.push("MySQL SQL foreign key constraint set differs");
  issues.push(
    ...compareChecks(postgresSql, mysqlSql),
    ...compareIdentityInitialization(postgresSql, mysqlSql),
  );
  const task = mysqlSchema.models.get("UploadTask");
  const activeColumn = databaseName(
    MYSQL_ACTIVE_FIELD,
    task?.fields.get(MYSQL_ACTIVE_FIELD)?.attributes ?? "",
  );
  const active = tables
    .get(task ? databaseName(task.name, task.attributes.join(" ")) : "")
    ?.fields.get(activeColumn);
  if (
    active !==
    "CHAR(36) GENERATED ALWAYS AS (CASE WHEN `status` IN ('PREPARED', 'PROCESSING') THEN `project_id` ELSE NULL END) VIRTUAL"
  )
    issues.push("Active task generated expression differs");
  if (
    !/upload_tasks_one_active_task_per_project[^;]+WHERE\s+"status" IN \('PREPARED', 'PROCESSING'\)/.test(
      postgresSql,
    )
  )
    issues.push("PostgreSQL active task partial unique changed");
  if (!/SET time_zone = '\+00:00';/.test(mysqlSql))
    issues.push("MySQL migration UTC session missing");
  return issues;
}
