import { describe, expect, it, vi } from "vitest";

import { isDatabaseUniqueViolation, isRetryableDatabaseTransaction } from "../database-errors.js";
import { assertSameText, textDigest } from "./path-identity.js";
import { retryMysqlTransaction } from "./transaction.js";

describe("MySQL transaction failure boundaries", () => {
  it("retries complete operations for driver deadlocks, then returns the committed result", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce({
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: "1213" } } },
      })
      .mockResolvedValue("committed");
    await expect(retryMysqlTransaction(operation)).resolves.toBe("committed");
    expect(operation).toHaveBeenCalledTimes(2);
  });
  it("bounds lock retries and strips the last driver error", async () => {
    const operation = vi.fn().mockRejectedValue({ code: "P2034", message: "secret SQL" });
    await expect(retryMysqlTransaction(operation)).rejects.toThrow(
      "Database operation failed (transaction)",
    );
    expect(operation).toHaveBeenCalledTimes(3);
  });
  it("does not retry domain errors or ordinary uniqueness conflicts", async () => {
    for (const error of [new Error("PROJECT_FORBIDDEN"), { code: "P2002" }]) {
      const operation = vi.fn().mockRejectedValue(error);
      await expect(retryMysqlTransaction(operation)).rejects.toBe(error);
      expect(operation).toHaveBeenCalledTimes(1);
    }
  });
  it("recognizes nested driver codes without treating unrelated failures as retryable", () => {
    expect(
      isDatabaseUniqueViolation({
        meta: { driverAdapterError: { cause: { originalCode: 1062 } } },
      }),
    ).toBe(true);
    expect(isRetryableDatabaseTransaction({ errno: 1205 })).toBe(true);
    expect(isRetryableDatabaseTransaction({ code: "P2028" })).toBe(false);
  });
  it("keeps exact text identity and refuses hash-hit mismatches", () => {
    expect(textDigest("中文😀/A.html")).not.toEqual(textDigest("中文😀/a.html"));
    expect(textDigest("x").length).toBe(32);
    expect(() => assertSameText("A.html", "a.html")).toThrow(
      "Database operation failed (identity)",
    );
  });
});
