import type { ClaimedObjectSweep } from "@html-share/db";
import type { ObjectStore } from "@html-share/storage";

const OBJECT_LIST_PAGE_SIZE = 1_000;
const DELETE_BATCH_SIZE = 1_000;
const DEFAULT_LIST_TIMEOUT_MS = 10_000;

export interface OrphanObjectSweepRepository {
  claimObjectSweep(now: Date): Promise<ClaimedObjectSweep | null>;
  referencedObjectKeys(keys: readonly string[]): Promise<Set<string>>;
  completeObjectSweep(input: {
    claimedAt: Date;
    nextContinuationToken?: string;
    now: Date;
  }): Promise<void>;
  retryObjectSweep(input: { claimedAt: Date; now: Date }): Promise<void>;
}

export async function runNextOrphanObjectSweep(input: {
  repository: OrphanObjectSweepRepository;
  storage: ObjectStore;
  now?: () => Date;
  listTimeoutMs?: number;
}): Promise<"idle" | "completed" | "retry"> {
  const now = input.now ?? (() => new Date());
  const listTimeoutMs = input.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  if (!Number.isInteger(listTimeoutMs) || listTimeoutMs < 1) {
    throw new Error("listTimeoutMs must be a positive integer");
  }
  const sweep = await input.repository.claimObjectSweep(now());
  if (sweep === null) return "idle";
  try {
    const page = await listObjectsWithTimeout(
      input.storage,
      sweep.continuationToken,
      listTimeoutMs,
    );
    const referenced = await input.repository.referencedObjectKeys(page.keys);
    const orphans = page.keys.filter((key) => !referenced.has(key));
    for (let offset = 0; offset < orphans.length; offset += DELETE_BATCH_SIZE) {
      await input.storage.deleteObjects(orphans.slice(offset, offset + DELETE_BATCH_SIZE));
    }
    await input.repository.completeObjectSweep({
      claimedAt: sweep.claimedAt,
      ...(page.nextContinuationToken === undefined
        ? {}
        : { nextContinuationToken: page.nextContinuationToken }),
      now: now(),
    });
    return "completed";
  } catch {
    await input.repository.retryObjectSweep({ claimedAt: sweep.claimedAt, now: now() });
    return "retry";
  }
}

async function listObjectsWithTimeout(
  storage: ObjectStore,
  continuationToken: string | undefined,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("OBJECT_LIST_TIMEOUT"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      storage.listObjects({
        abortSignal: controller.signal,
        ...(continuationToken === undefined ? {} : { continuationToken }),
        maxKeys: OBJECT_LIST_PAGE_SIZE,
        prefix: "projects/",
        timeoutMs,
      }),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
