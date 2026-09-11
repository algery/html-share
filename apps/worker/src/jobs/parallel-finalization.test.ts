import { describe, expect, it } from "vitest";

import { runParallelFinalizers } from "./parallel-finalization.js";

describe("runParallelFinalizers", () => {
  it("starts every bounded finalizer before awaiting the batch", async () => {
    const started: number[] = [];
    const releases: (() => void)[] = [];
    const batch = runParallelFinalizers(
      10,
      () =>
        new Promise<number>((resolve) => {
          started.push(started.length + 1);
          releases.push(() => resolve(started.length));
        }),
    );

    expect(started).toHaveLength(10);
    for (const release of releases) release();
    await expect(batch).resolves.toHaveLength(10);
  });

  it("rejects an unsafe concurrency value", async () => {
    await expect(runParallelFinalizers(0, async () => "idle")).rejects.toThrow(
      "UPLOAD_FINALIZATION_CONCURRENCY",
    );
  });

  it("waits for every started finalizer before surfacing a failure", async () => {
    let calls = 0;
    let releaseSlow: (() => void) | undefined;
    const batch = runParallelFinalizers(2, async () => {
      calls += 1;
      if (calls === 1) throw new Error("first failed");
      await new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
      return "slow completed";
    });

    await Promise.resolve();
    expect(releaseSlow).toBeTypeOf("function");
    let settled = false;
    void batch.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseSlow?.();
    await expect(batch).rejects.toThrow("first failed");
  });
});
