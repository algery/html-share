export class DatabaseOperationError extends Error {
  constructor(operation: "transaction" | "identity" | "startup" | "repository") {
    super(`Database operation failed (${operation})`);
    this.name = "DatabaseOperationError";
  }
}

function errorCodes(error: unknown): Set<string> {
  const codes = new Set<string>();
  const seen = new Set<object>();
  const inspect = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return;
    seen.add(value);
    for (const key of ["code", "errno", "originalCode", "sqlState"]) {
      const code = Reflect.get(value, key);
      if (typeof code === "string" || typeof code === "number") codes.add(String(code));
    }
    for (const key of ["cause", "meta", "driverAdapterError", "error"])
      inspect(Reflect.get(value, key), depth + 1);
  };
  inspect(error, 0);
  return codes;
}

export function isDatabaseUniqueViolation(error: unknown): boolean {
  const codes = errorCodes(error);
  return ["P2002", "1062", "ER_DUP_ENTRY", "23505"].some((code) => codes.has(code));
}

export function isRetryableDatabaseTransaction(error: unknown): boolean {
  const codes = errorCodes(error);
  return [
    "P2034",
    "1213",
    "1205",
    "ER_LOCK_DEADLOCK",
    "ER_LOCK_WAIT_TIMEOUT",
    "40001",
    "40P01",
  ].some((code) => codes.has(code));
}
