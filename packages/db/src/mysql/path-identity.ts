import { createHash } from "node:crypto";

import { DatabaseOperationError } from "../database-errors.js";

export function textDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function assertSameText(actual: string, expected: string): void {
  if (actual !== expected) throw new DatabaseOperationError("identity");
}
