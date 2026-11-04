import { sqlTokens } from "./database-schema-tokens.mjs";

// This checker supports initial tables and additive constraints, not arbitrary
// SQL execution. Fail closed when a migration needs semantics it cannot model.
export function unsupportedMysqlStatements(sql) {
  const tokens = sqlTokens(sql);
  const statements = [[]];
  for (const token of tokens) {
    if (token === ";") statements.push([]);
    else statements.at(-1).push(token);
  }
  const issues = [];
  if (/\/\*[!+]/.test(sql)) issues.push("Unsupported MySQL executable comment or optimizer hint");
  const created = new Set();
  for (const statement of statements.filter((items) => items.length)) {
    const [verb, kind, name] = statement;
    if (verb === "set") {
      if (JSON.stringify(statement) !== JSON.stringify(["set", "time_zone", "=", "'+00:00'"]))
        issues.push("Unsupported MySQL session statement");
    } else if (verb === "create" && kind === "table") {
      if (created.has(name)) issues.push(`Duplicate MySQL table creation: ${name}`);
      created.add(name);
    } else if (verb === "create" && (kind === "index" || (kind === "unique" && name === "index"))) {
      // The exact index set is checked against the models separately.
    } else if (verb === "alter" && kind === "table") {
      // Only the additive forms parsed by unsupportedMysqlAlterations are allowed.
    } else if (verb === "insert" && kind === "into" && name === "database_identity") {
      // Exact singleton initialization is checked separately.
    } else issues.push(`Unsupported MySQL statement: ${verb}`);
  }
  return issues;
}

export function unsupportedMysqlColumn(definition) {
  const tokens = sqlTokens(definition);
  // The physical whitelist has signed numbers, exact full-text comparison and
  // immutable generated fields; column-level overrides must be modeled first.
  return tokens.some((token) =>
    [
      "unsigned",
      "zerofill",
      "collate",
      "character",
      "charset",
      "auto_increment",
      "invisible",
      "references",
      "on",
    ].includes(token),
  );
}

export function unsupportedPostgresIdentityTail(sql) {
  const tokens = sqlTokens(sql);
  const start = tokens.findIndex(
    (token, index) =>
      token === "create" &&
      tokens[index + 1] === "table" &&
      tokens[index + 5] === "database_identity",
  );
  if (start < 0) return ["PostgreSQL identity migration is missing"];
  const statements = [[]];
  for (const token of tokens.slice(start)) {
    if (token === ";") statements.push([]);
    else statements.at(-1).push(token);
  }
  const issues = [];
  for (const statement of statements.filter((items) => items.length)) {
    const create =
      statement[0] === "create" && statement[1] === "table" && statement[5] === "database_identity";
    const insert =
      statement[0] === "insert" && statement[1] === "into" && statement[2] === "database_identity";
    if (!create && !insert)
      issues.push("Unsupported statement after PostgreSQL identity migration");
  }
  return issues;
}
