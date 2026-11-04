// Fold SQL syntax while keeping string literals byte-for-byte, including escapes.
export function sqlTokens(text) {
  return [
    ...text.matchAll(
      /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|\\.|[^'\\])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|[\w$]+|>=|<=|<>|!=|[^\s]/g,
    ),
  ]
    .map(([token]) => {
      if (token.startsWith("--") || token.startsWith("/*")) return null;
      if (token.startsWith("'")) return token;
      if (token.startsWith('"') || token.startsWith("`")) token = token.slice(1, -1);
      return token.toLowerCase();
    })
    .filter((token) => token !== null);
}

export function closeParen(tokens, start) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index] === "(") depth += 1;
    if (tokens[index] === ")" && --depth === 0) return index;
  }
  throw new Error("Unclosed SQL expression");
}

export function stripParens(tokens) {
  while (tokens[0] === "(" && closeParen(tokens, 0) === tokens.length - 1)
    tokens = tokens.slice(1, -1);
  return tokens;
}

export function tableAt(tokens, index) {
  if (!["create", "alter"].includes(tokens[index]) || tokens[index + 1] !== "table") return null;
  const offset = tokens[index + 2] === "if" ? 5 : 2;
  return tokens[index + offset];
}
