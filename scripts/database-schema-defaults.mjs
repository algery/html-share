import { closeParen, sqlTokens, stripParens } from "./database-schema-tokens.mjs";

function sqlDefault(definition) {
  const tokens = sqlTokens(definition),
    index = tokens.indexOf("default");
  if (index < 0) return null;
  const start = index + 1;
  const end =
    tokens[start] === "("
      ? closeParen(tokens, start) + 1
      : tokens[start + 1] === "("
        ? closeParen(tokens, start + 1) + 1
        : start + (tokens[start] === "-" ? 2 : 1);
  return stripParens(tokens.slice(start, end));
}

export function compareDefault(model, name, field, definition, enums) {
  let expected = null;
  // The internal identity is created before any client exists; this physical
  // default is intentionally absent from both client schemas.
  if (model.name === "DatabaseIdentity" && name === "instanceId") expected = ["uuid", "(", ")"];
  else if (/@default\(now\(\)\)/.test(field.attributes))
    expected = ["current_timestamp", "(", "3", ")"];
  else {
    const value = /@default\(("(?:[^"\\]|\\.)*"|\w+|-?\d+)\)/.exec(field.attributes)?.[1];
    if (value !== undefined) {
      if (value.startsWith('"')) expected = [quote(JSON.parse(value))];
      else if (enums.has(field.type.replace("?", ""))) expected = [quote(value)];
      else expected = sqlTokens(value);
    }
  }
  return JSON.stringify(sqlDefault(definition)) === JSON.stringify(expected);
}

function quote(value) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

export function compareIdentityInitialization(postgresSql, mysqlSql) {
  const issues = [];
  const mysql = sqlTokens(mysqlSql),
    pg = sqlTokens(postgresSql);
  const inserts = (tokens) => {
    const result = [];
    for (let index = 0; index < tokens.length; index += 1) {
      if (
        tokens[index] !== "insert" ||
        tokens[index + 1] !== "into" ||
        tokens[index + 2] !== "database_identity"
      )
        continue;
      const end = tokens.indexOf(";", index);
      result.push(tokens.slice(index, end < 0 ? tokens.length : end));
    }
    return result;
  };
  const expectedMysql = sqlTokens(
    "INSERT INTO database_identity (id, updated_at) VALUES (1, CURRENT_TIMESTAMP(3))",
  );
  const expectedPg = sqlTokens(
    "INSERT INTO database_identity (id) VALUES (1) ON CONFLICT (id) DO NOTHING",
  );
  if (JSON.stringify(inserts(mysql)) !== JSON.stringify([expectedMysql]))
    issues.push("MySQL database_identity initialization differs");
  if (JSON.stringify(inserts(pg)) !== JSON.stringify([expectedPg]))
    issues.push("PostgreSQL database_identity initialization differs");
  // PostgreSQL metadata has additional server defaults because its seed only
  // supplies id. Keep these explicit physical exceptions under the same gate.
  const table =
    /CREATE TABLE IF NOT EXISTS "database_identity"\s*\(([\s\S]*?)\n\);/.exec(postgresSql)?.[1] ??
    "";
  for (const [column, expected] of Object.entries({
    instance_id: "gen_random_uuid()",
    updated_at: "CURRENT_TIMESTAMP",
  })) {
    const definition = new RegExp(`"${column}" ([^,\\n]+)`).exec(table)?.[1] ?? "";
    if (JSON.stringify(sqlDefault(definition)) !== JSON.stringify(sqlTokens(expected)))
      issues.push(`PostgreSQL database_identity.${column} default differs`);
  }
  return issues;
}
