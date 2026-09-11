import { digestManifest } from "@html-share/core";
import type { ProcessingUpload } from "@html-share/db";
import type { ObjectStore } from "@html-share/storage";

export interface UploadFinalizerRepository {
  claimNextProcessingUpload(now: Date): Promise<ProcessingUpload | null>;
  publishUpload(input: { uploadId: string; now: Date }): Promise<boolean>;
  markUploadFilesVerified(input: { uploadId: string; now: Date }): Promise<void>;
  failUpload(input: { uploadId: string; failureCode: string; now: Date }): Promise<boolean>;
}

const DEFAULT_HEAD_OBJECT_TIMEOUT_MS = 10_000;
const HEAD_OBJECT_CONCURRENCY = 20;

export async function finalizeNextUpload(input: {
  onOutcome?: (outcome: { status: "published" | "failed"; traceId?: string }) => void;
  repository: UploadFinalizerRepository;
  storage: ObjectStore;
  now?: () => Date;
  headObjectTimeoutMs?: number;
}): Promise<"idle" | "published" | "failed"> {
  const now = input.now ?? (() => new Date());
  const headObjectTimeoutMs = input.headObjectTimeoutMs ?? DEFAULT_HEAD_OBJECT_TIMEOUT_MS;
  if (!Number.isInteger(headObjectTimeoutMs) || headObjectTimeoutMs < 1) {
    throw new Error("headObjectTimeoutMs must be a positive integer");
  }
  const task = await input.repository.claimNextProcessingUpload(now());
  if (task === null) return "idle";
  let outcome: "published" | "failed" = "failed";
  try {
    validateTaskManifest(task);
    await mapWithConcurrency(task.files, HEAD_OBJECT_CONCURRENCY, async (file) => {
      const metadata = await headObjectWithTimeout(
        input.storage,
        file.storageKey,
        headObjectTimeoutMs,
      );
      if (metadata === null) throw new FinalizeError("UPLOAD_OBJECT_MISSING");
      if (metadata.size !== file.size) throw new FinalizeError("UPLOAD_OBJECT_SIZE_MISMATCH");
      if (metadata.contentType !== file.mimeType) {
        throw new FinalizeError("UPLOAD_OBJECT_CONTENT_TYPE_MISMATCH");
      }
      if (metadata.contentMd5 !== file.contentMd5) {
        throw new FinalizeError("UPLOAD_OBJECT_CONTENT_MD5_MISMATCH");
      }
    });
    await input.repository.markUploadFilesVerified({ now: now(), uploadId: task.uploadId });
    const publicationCommitted = await input.repository.publishUpload({
      now: now(),
      uploadId: task.uploadId,
    });
    if (!publicationCommitted) throw new FinalizeError("PUBLISH_NOT_APPLIED");
    outcome = "published";
    return "published";
  } catch (error) {
    await input.repository.failUpload({
      failureCode: errorCode(error),
      now: now(),
      uploadId: task.uploadId,
    });
    // Never delete here: a stale lease holder may race a successful publisher,
    // and signed PUTs may remain in flight. Post-expiry cleanup owns all deletion.
    return "failed";
  } finally {
    input.onOutcome?.({
      status: outcome,
      ...(task.traceId === undefined ? {} : { traceId: task.traceId }),
    });
  }
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
) {
  let nextIndex = 0;
  let firstError: unknown;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (firstError === undefined && nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) {
          try {
            await operation(value);
          } catch (error) {
            firstError ??= error;
          }
        }
      }
    }),
  );
  if (firstError !== undefined) throw firstError;
}

async function headObjectWithTimeout(storage: ObjectStore, key: string, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new FinalizeError("UPLOAD_OBJECT_HEAD_TIMEOUT"));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      storage.headObject(key, { abortSignal: controller.signal, timeoutMs }),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function validateTaskManifest(task: ProcessingUpload) {
  const totalSize = task.files.reduce((total, file) => total + file.size, 0);
  if (task.files.length !== task.declaredFileCount || totalSize !== task.declaredTotalSize) {
    throw new FinalizeError("UPLOAD_DECLARATION_MISMATCH");
  }
  if (!task.files.some((file) => file.path === task.targetHtml)) {
    throw new FinalizeError("TARGET_HTML_MISSING");
  }
  const manifestDigest = digestManifest(
    task.files.map((file) => ({
      contentMd5: file.contentMd5,
      mimeType: file.mimeType,
      relativePath: file.path,
      sha256: file.contentHash,
      size: file.size,
    })),
  );
  if (manifestDigest !== task.manifestDigest) throw new FinalizeError("UPLOAD_MANIFEST_MISMATCH");
}

function errorCode(error: unknown) {
  return error instanceof FinalizeError ? error.code : "UPLOAD_FINALIZATION_FAILED";
}

class FinalizeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
