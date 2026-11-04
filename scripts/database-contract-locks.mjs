import { setTimeout } from "node:timers/promises";

export async function waitForProjectWait(fixture, minimum = 1) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const rows =
      fixture.provider === "postgresql"
        ? await fixture.db.$queryRaw`
          SELECT COUNT(*) AS blocked FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND state = 'active' AND wait_event_type = 'Lock'
            AND query LIKE '%demo_projects%' AND query LIKE '%FOR %'`
        : await fixture.db.$queryRaw`
            SELECT COUNT(DISTINCT w.REQUESTING_ENGINE_TRANSACTION_ID) AS blocked
            FROM performance_schema.data_lock_waits w
          JOIN performance_schema.data_locks l
            ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
          WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'demo_projects'`;
    if (Number(rows[0]?.blocked) >= minimum) return;
    await setTimeout(10);
  }
  throw new Error("Independent repository connection never waited on the actual project row lock");
}

/** Hold a SQL row lock, observe the real waiter, commit mutation, then inspect its result. */
export async function interleaveProject(fixture, projectId, operation, mutation, whileBlocked) {
  let release;
  let announce;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    announce = resolve;
  });
  const transaction = fixture.db.$transaction(
    async (tx) => {
      if (fixture.provider === "postgresql") {
        await tx.$queryRaw`SELECT id FROM demo_projects WHERE id = ${projectId}::uuid FOR UPDATE`;
      } else {
        await tx.$queryRaw`SELECT id FROM demo_projects WHERE id = ${projectId} FOR UPDATE`;
      }
      announce();
      await held;
      await mutation(tx);
    },
    { timeout: 12_000 },
  );
  // Handle rejection immediately, including failures before the lock barrier.
  const blocker = transaction.then(
    () => ({ ok: true }),
    (error) => ({ error }),
  );
  let pending;
  let blocked;
  try {
    await Promise.race([ready, transaction]);
    pending = operation().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitForProjectWait(fixture);
    await whileBlocked?.();
  } finally {
    release();
    blocked = await blocker;
    await pending;
  }
  if (blocked.error) throw blocked.error;
  const outcome = await pending;
  if (outcome.error) throw outcome.error;
  return outcome.value;
}

export async function waitForDatabaseDeadline(fixture, deadline) {
  const end = Date.now() + 3_000;
  while (Date.now() < end) {
    const rows =
      fixture.provider === "postgresql"
        ? await fixture.db.$queryRaw`SELECT clock_timestamp() AS now`
        : await fixture.db.$queryRaw`SELECT CURRENT_TIMESTAMP(3) AS now`;
    if (rows[0].now.getTime() >= deadline.getTime()) return;
    await setTimeout(10);
  }
  throw new Error("Database clock did not pass the contract deadline");
}
