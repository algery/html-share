import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createDatabaseFixture } from "../packages/db/src/testing/database-fixture.ts";
import { mysqlTransaction } from "../packages/db/src/mysql/transaction.ts";

const enabled = Boolean(
  process.env.PHASE25_CONTRACT_REQUIRED ||
  process.env.PHASE25_MYSQL_URL ||
  process.env.PHASE25_POSTGRES_URL,
);

(enabled ? describe : describe.skip)("Phase 25 mysql: real deadlock recovery", () => {
  it("rolls back the deadlock victim and retries the complete transaction once locks are released", async () => {
    const first = createDatabaseFixture("mysql");
    const second = createDatabaseFixture("mysql");
    if (first.provider !== "mysql" || second.provider !== "mysql")
      throw new Error("MySQL fixture required");
    const ids = [`dl-a-${randomUUID().slice(0, 16)}`, `dl-b-${randomUUID().slice(0, 16)}`];
    let announceFirst;
    let announceSecond;
    const firstLocked = new Promise((resolve) => {
      announceFirst = resolve;
    });
    const secondLocked = new Promise((resolve) => {
      announceSecond = resolve;
    });
    const attempts = [0, 0];
    try {
      for (const id of ids)
        await first.client.objectSweepState.create({
          data: { id, continuationToken: "0", runAfter: new Date() },
        });
      const operation = (client, index) =>
        mysqlTransaction(client, async (tx) => {
          attempts[index] += 1;
          const [left, right] = index === 0 ? ids : [...ids].reverse();
          await tx.$queryRaw`SELECT id FROM object_sweep_states WHERE id = ${left} FOR UPDATE`;
          const own = await tx.objectSweepState.findUniqueOrThrow({ where: { id: left } });
          await tx.objectSweepState.update({
            where: { id: left },
            data: { continuationToken: String(Number(own.continuationToken) + 1) },
          });
          if (index === 0) announceFirst();
          else announceSecond();
          // Both first-row locks are confirmed by completed SQL, so these two
          // opposite second locks force an actual InnoDB wait-for cycle.
          await Promise.all([firstLocked, secondLocked]);
          await tx.$queryRaw`SELECT id FROM object_sweep_states WHERE id = ${right} FOR UPDATE`;
          const other = await tx.objectSweepState.findUniqueOrThrow({ where: { id: right } });
          await tx.objectSweepState.update({
            where: { id: right },
            data: { continuationToken: String(Number(other.continuationToken) + 1) },
          });
        });
      await Promise.all([operation(first.client, 0), operation(second.client, 1)]);
      expect(attempts[0] + attempts[1]).toBeGreaterThanOrEqual(3);
      expect(attempts.every((count) => count <= 3)).toBe(true);
      const rows = await first.client.objectSweepState.findMany({ where: { id: { in: ids } } });
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.continuationToken)).toEqual(["2", "2"]);
    } finally {
      await first.client.objectSweepState.deleteMany({ where: { id: { in: ids } } });
      await Promise.all([first.client.$disconnect(), second.client.$disconnect()]);
    }
  }, 15_000);
});
