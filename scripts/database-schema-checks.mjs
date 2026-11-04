import { closeParen, sqlTokens, stripParens, tableAt } from "./database-schema-tokens.mjs";

function checkExpressions(sql) {
  const checks = new Map(),
    tokens = sqlTokens(sql);
  let table = null;
  for (let index = 0; index < tokens.length; index += 1) {
    table = tableAt(tokens, index) ?? table;
    if (tokens[index] === "drop" && ["constraint", "check"].includes(tokens[index + 1])) {
      const offset = tokens[index + 2] === "if" ? 4 : 2;
      checks.delete(`${table}.${tokens[index + offset]}`);
    }
    if (tokens[index] !== "check" || tokens[index + 1] !== "(") continue;
    const name = tokens[index - 2] === "constraint" ? tokens[index - 1] : `<unnamed:${index}>`;
    const start = index + 1,
      end = closeParen(tokens, start);
    const expression = tokens.slice(start + 1, end);
    if (tokens[end + 1] === "not" && tokens[end + 2] === "enforced")
      expression.push("not", "enforced");
    checks.set(`${table}.${name}`, expression);
    index = end;
  }
  return checks;
}

function booleanExpression(tokens) {
  const value = stripParens(tokens);
  for (const operator of ["or", "and"]) {
    const parts = [];
    let depth = 0,
      start = 0;
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === "(") depth += 1;
      if (value[index] === ")") depth -= 1;
      if (depth === 0 && value[index] === operator) {
        parts.push(value.slice(start, index));
        start = index + 1;
      }
    }
    if (parts.length) return [operator, ...[...parts, value.slice(start)].map(booleanExpression)];
  }
  return value.map((token) => (token === "char_length" ? "length" : token));
}

// Compare all historical checks using the last definition on each owning table.
export function compareChecks(postgresSql, mysqlSql) {
  const issues = [];
  const pgChecks = checkExpressions(postgresSql),
    mysqlChecks = checkExpressions(mysqlSql);
  if (
    JSON.stringify([...pgChecks.keys()].sort()) !== JSON.stringify([...mysqlChecks.keys()].sort())
  )
    issues.push("SQL CHECK constraint set differs");
  for (const [name, expression] of pgChecks) {
    if (
      JSON.stringify(booleanExpression(expression)) !==
      JSON.stringify(booleanExpression(mysqlChecks.get(name) ?? []))
    )
      issues.push(`${name} CHECK expression differs`);
  }
  return issues;
}
