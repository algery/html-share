import { isRetryableDatabaseTransaction } from "../packages/db/dist/database-errors.js";
import { performance } from "node:perf_hooks";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export function percentile(values, fraction = 0.95) {
  if (!values.length || values.some((value) => !Number.isFinite(value)))
    throw new Error("Capacity samples must be finite and nonempty");
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
}
export const round = (value) => Math.round(value * 100) / 100;

// Observe first response headers, then consume and verify the full body separately.
export function timedRead(url, headers = {}) {
  const target = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(target.hostname))
    throw new Error("Only isolated loopback reads are allowed");
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(
      target,
      {
        headers,
        ...(target.protocol === "https:" ? { rejectUnauthorized: false } : {}),
      },
      (response) => {
        const ttfbMs = performance.now() - started;
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            ttfbMs,
            durationMs: performance.now() - started,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.once("error", reject);
    request.setTimeout(15_000, () => request.destroy(new Error("Capacity request timed out")));
    request.end();
  });
}

export async function databaseSample(prisma, provider) {
  if (provider === "mysql") {
    const connections =
      await prisma.$queryRaw`SELECT COUNT(*) AS total, SUM(COMMAND <> 'Sleep') AS active FROM information_schema.PROCESSLIST WHERE DB = DATABASE()`;
    const status =
      await prisma.$queryRaw`SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_row_lock_waits', 'Innodb_row_lock_current_waits', 'Threads_connected', 'Threads_running')`;
    const [deadlock] =
      await prisma.$queryRaw`SELECT COUNT AS deadlocks FROM information_schema.INNODB_METRICS WHERE NAME = 'lock_deadlocks' AND STATUS = 'enabled'`;
    const numbers = Object.fromEntries(status.map((row) => [row.Variable_name, Number(row.Value)]));
    if (!deadlock || !Object.hasOwn(numbers, "Innodb_row_lock_waits"))
      throw new Error("MySQL lock/deadlock telemetry unavailable");
    return {
      connections: Number(connections[0].total),
      active: Number(connections[0].active),
      lockWaits: numbers.Innodb_row_lock_waits,
      currentLockWaits: numbers.Innodb_row_lock_current_waits,
      deadlocks: Number(deadlock.deadlocks),
    };
  }
  const [sample] =
    await prisma.$queryRaw`SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS connections, (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active') AS active, (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock') AS current_lock_waits, deadlocks FROM pg_stat_database WHERE datname = current_database()`;
  return {
    connections: Number(sample.connections),
    active: Number(sample.active),
    currentLockWaits: Number(sample.current_lock_waits),
    deadlocks: Number(sample.deadlocks),
  };
}

export async function backlog(prisma, tenantId) {
  const tasks = await prisma.uploadTask.findMany({
    where: { tenantId },
    select: { id: true, projectId: true, revisionId: true },
  });
  const targetIds = tasks.flatMap((task) => [task.id, task.projectId, task.revisionId]);
  return {
    incompleteUploads: await prisma.uploadTask.count({
      where: { tenantId, status: { in: ["PREPARED", "PROCESSING"] } },
    }),
    cleanupPending: await prisma.cleanupJob.count({
      where: { targetId: { in: targetIds }, status: { in: ["PENDING", "RUNNING", "RETRY"] } },
    }),
    cleanupRetries: await prisma.cleanupJob
      .aggregate({ where: { targetId: { in: targetIds } }, _sum: { attemptCount: true } })
      .then((value) => value._sum.attemptCount ?? 0),
  };
}

// Pass through every transaction unchanged; count real driver failures before repository retry logic.
export function observeTransactions(prisma) {
  const original = prisma.$transaction;
  const activity = { attempts: 0, failed: 0, retryableFailures: 0 };
  prisma.$transaction = async function (...args) {
    activity.attempts++;
    try {
      return await Reflect.apply(original, prisma, args);
    } catch (error) {
      activity.failed++;
      if (isRetryableDatabaseTransaction(error)) activity.retryableFailures++;
      throw error;
    }
  };
  return activity;
}
