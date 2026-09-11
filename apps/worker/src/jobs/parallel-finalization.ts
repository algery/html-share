/**
 * Starts a bounded number of independent claims together. The repository uses
 * `FOR UPDATE SKIP LOCKED`, so each finalizer receives at most one upload task.
 */
export async function runParallelFinalizers<T>(
  concurrency: number,
  finalize: () => Promise<T>,
): Promise<T[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("UPLOAD_FINALIZATION_CONCURRENCY must be a positive integer");
  }
  const settled = await Promise.allSettled(Array.from({ length: concurrency }, finalize));
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected !== undefined) throw rejected.reason;
  return settled.map((result) => {
    if (result.status === "fulfilled") return result.value;
    throw new Error("unreachable");
  });
}
