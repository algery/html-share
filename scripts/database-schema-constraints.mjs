import { closeParen, sqlTokens, tableAt } from "./database-schema-tokens.mjs";

export const indexSignature = (unique, fields) => JSON.stringify([unique, fields]);
export const foreignKeySignature = (table, from, target, to, onDelete, onUpdate) =>
  JSON.stringify([table, from, target, to, onDelete.toLowerCase(), onUpdate.toLowerCase()]);

function columns(tokens, start) {
  return tokens.slice(start + 1, closeParen(tokens, start)).filter((token) => token !== ",");
}

export function foreignKeys(sql) {
  const tokens = sqlTokens(sql),
    result = [];
  let table = null;
  for (let index = 0; index < tokens.length; index += 1) {
    table = tableAt(tokens, index) ?? table;
    if (tokens[index] !== "foreign" || tokens[index + 1] !== "key" || tokens[index + 2] !== "(")
      continue;
    const start = index + 2,
      end = closeParen(tokens, start);
    const target = tokens[end + 2],
      targetStart = end + 3;
    const targetEnd = closeParen(tokens, targetStart);
    const action = (kind) => {
      for (let cursor = targetEnd + 1; cursor < tokens.length; cursor += 1) {
        if ([";", ","].includes(tokens[cursor])) break;
        if (tokens[cursor] === "on" && tokens[cursor + 1] === kind) {
          const first = tokens[cursor + 2];
          return ["set", "no"].includes(first) ? `${first} ${tokens[cursor + 3]}` : first;
        }
      }
      return "restrict";
    };
    result.push(
      foreignKeySignature(
        table,
        columns(tokens, start),
        target,
        columns(tokens, targetStart),
        action("delete"),
        action("update"),
      ),
    );
    index = targetEnd;
  }
  return result.sort();
}

// Capture additional constraints regardless of INDEX/KEY spelling or whether
// they are declared inline, as named constraints, or in later ALTER statements.
export function collectMysqlKeys(sql, tables) {
  const tokens = sqlTokens(sql);
  let table = null,
    alter = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const owner = tableAt(tokens, index);
    if (owner) {
      table = tables.get(owner);
      alter = tokens[index] === "alter";
    }
    // Standalone CREATE INDEX has its own owner rather than the preceding ALTER.
    if (tokens[index] === "create" && ["unique", "index"].includes(tokens[index + 1])) {
      const offset = tokens[index + 1] === "unique" ? 5 : 4;
      table = tables.get(tokens[index + offset]);
      alter = false;
    }
    if (!table) continue;
    const token = tokens[index];
    if (token === "primary" && tokens[index + 1] === "key" && tokens[index + 2] === "(") {
      const start = index + 2;
      table.primary = columns(tokens, start);
      index = closeParen(tokens, start);
    } else if (
      token === "unique" ||
      (alter &&
        ["index", "key"].includes(token) &&
        !["foreign", "primary"].includes(tokens[index - 1]))
    ) {
      let start = index + 1;
      if (["index", "key"].includes(tokens[start])) start += 1;
      if (tokens[start] !== "(") start += 1; // optional index name
      if (tokens[start] !== "(") continue;
      table.indexes.add(indexSignature(token === "unique", columns(tokens, start)));
      index = closeParen(tokens, start);
    }
  }
}

// This gate understands initial CREATEs and additive constraints. Reject other
// MySQL ALTER operations instead of silently comparing the pre-ALTER state.
export function unsupportedMysqlAlterations(sql) {
  const tokens = sqlTokens(sql),
    issues = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "alter" || tokens[index + 1] !== "table") continue;
    let start = index + 3;
    if (tokens[start] !== "add") {
      issues.push(`Unsupported MySQL ALTER on ${tokens[index + 2]}`);
      continue;
    }
    start += 1;
    if (tokens[start] === "constraint") start += 2;
    if (!["foreign", "check", "primary", "unique", "index", "key"].includes(tokens[start]))
      issues.push(`Unsupported MySQL ALTER on ${tokens[index + 2]}`);
    // Multiple operations need replay support before they can be accepted.
    let depth = 0;
    for (let cursor = start; cursor < tokens.length && tokens[cursor] !== ";"; cursor += 1) {
      if (tokens[cursor] === "(") depth += 1;
      if (tokens[cursor] === ")") depth -= 1;
      if (tokens[cursor] === "," && depth === 0)
        issues.push(`Unsupported compound MySQL ALTER on ${tokens[index + 2]}`);
    }
  }
  return issues;
}
