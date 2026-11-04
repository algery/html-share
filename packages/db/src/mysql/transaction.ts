import { setTimeout } from "node:timers/promises";

import { DatabaseOperationError, isRetryableDatabaseTransaction } from "../database-errors.js";
import type { MysqlClient, MysqlTransactionClient } from "./types.js";

export async function retryMysqlTransaction<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableDatabaseTransaction(error)) throw error;
      if (attempt === 2) throw new DatabaseOperationError("transaction");
      await setTimeout(10 * (attempt + 1));
    }
  }
  throw new DatabaseOperationError("transaction");
}

// Only database work belongs in the callback: retries must not repeat uploads,
// password generation, HTTP calls, or other external side effects.
export function mysqlTransaction<T>(
  prisma: MysqlClient,
  operation: (transaction: MysqlTransactionClient) => Promise<T>,
): Promise<T> {
  return retryMysqlTransaction(() =>
    prisma.$transaction(operation, {
      isolationLevel: "ReadCommitted",
      maxWait: 5_000,
      timeout: 10_000,
    }),
  );
}
