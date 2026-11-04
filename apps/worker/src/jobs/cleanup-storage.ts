import type { ObjectStore } from "@html-share/storage";

const OBJECT_DELETE_BATCH_SIZE = 1_000;

export interface CleanupStorageRepository {
  claimNextCleanupJob(now: Date): Promise<{
    attemptCount: number;
    id: string;
    kind: "auth_state" | "project" | "revision" | "upload";
    objectKeys: string[];
  } | null>;
  completeCleanupJob(input: {
    claimAttempt: number;
    id: string;
    kind: "auth_state" | "project" | "revision" | "upload";
    now: Date;
  }): Promise<void>;
  enqueueDueCleanupJobs(now: Date): Promise<number>;
  retryCleanupJob(input: {
    errorCode: string;
    id: string;
    now: Date;
    claimAttempt: number;
  }): Promise<void>;
}

export async function runNextCleanupJob(input: {
  repository: CleanupStorageRepository;
  storage: ObjectStore;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  await input.repository.enqueueDueCleanupJobs(now());
  const job = await input.repository.claimNextCleanupJob(now());
  if (job === null) return "idle" as const;
  try {
    for (const keys of objectKeyBatches(job.objectKeys)) await input.storage.deleteObjects(keys);
    await input.repository.completeCleanupJob({
      id: job.id,
      kind: job.kind,
      now: now(),
      claimAttempt: job.attemptCount,
    });
    return "completed" as const;
  } catch (error) {
    await input.repository.retryCleanupJob({
      errorCode: cleanupErrorCode(error),
      claimAttempt: job.attemptCount,
      id: job.id,
      now: now(),
    });
    return "retry" as const;
  }
}

function* objectKeyBatches(keys: readonly string[]) {
  for (let index = 0; index < keys.length; index += OBJECT_DELETE_BATCH_SIZE)
    yield keys.slice(index, index + OBJECT_DELETE_BATCH_SIZE);
}

function cleanupErrorCode(error: unknown) {
  if (error instanceof Error && /^[A-Z0-9_:-]{1,120}$/.test(error.message)) return error.message;
  return "CLEANUP_STORAGE_FAILED";
}
