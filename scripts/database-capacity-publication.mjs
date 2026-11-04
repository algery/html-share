import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { runParallelFinalizers } from "../apps/worker/dist/jobs/parallel-finalization.js";

export async function finalizeCapacityBatch(harness, uploadIds, check) {
  const started = performance.now();
  const completedAt = new Map();
  const rounds = [];
  let nextTick = started;
  // Match main.runJobs: ten bounded finalizers per two-second tick, no overlapping rounds.
  while (performance.now() - started < 60_000 && completedAt.size < uploadIds.length) {
    await delay(Math.max(0, nextTick - performance.now()));
    await harness.workerReadiness();
    const outcomes = await runParallelFinalizers(10, () => harness.finalize());
    const observed = performance.now();
    const tasks = await harness.prisma.uploadTask.findMany({
      where: { tenantId: harness.tenantId, id: { in: uploadIds } },
      select: { id: true, status: true, failureCode: true },
    });
    check(tasks.length === uploadIds.length, "All capacity tasks remain visible to their owner");
    for (const task of tasks)
      if (task.status === "COMPLETED" && !completedAt.has(task.id))
        completedAt.set(task.id, observed);
    rounds.push({
      atMs: Math.round(observed - started),
      published: outcomes.filter((value) => value === "published").length,
      idle: outcomes.filter((value) => value === "idle").length,
      backlog: tasks.filter((task) => task.status !== "COMPLETED").length,
    });
    if (
      outcomes.includes("failed") ||
      tasks.some((task) => ["FAILED", "EXPIRED"].includes(task.status))
    ) {
      console.error(
        JSON.stringify({
          stage: "capacity-finalizers",
          outcomes,
          tasks: tasks.map(({ status, failureCode }) => ({ status, failureCode })),
        }),
      );
      check(false, "Concurrent finalizers must never fail or expire a capacity upload");
    }
    nextTick += 2000;
    while (nextTick <= performance.now()) nextTick += 2000;
  }
  check(
    completedAt.size === uploadIds.length,
    "All ten concurrent uploads finish under real worker polling",
  );
  return { completedAt, rounds };
}
