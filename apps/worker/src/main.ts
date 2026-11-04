import { EnvironmentValidationError, readWorkerEnv } from "@html-share/config";
import {
  createCleanupRepository,
  createOrphanSweepRepository,
  createPasswordCleanupRepository,
  createPrismaClient,
  createUploadRepository,
} from "@html-share/db";
import { createObjectStore, observeObjectStoreActivity } from "@html-share/storage";
import { createTelemetry, createTraceId, redactLogValue } from "@html-share/observability";

import { buildWorkerApp } from "./app.js";
import { runNextCleanupJob } from "./jobs/cleanup-storage.js";
import { runPasswordAccessCleanup } from "./jobs/cleanup-password-access.js";
import { runNextOrphanObjectSweep } from "./jobs/sweep-orphan-objects.js";
import { finalizeNextUpload } from "./jobs/finalize-upload.js";
import { runParallelFinalizers } from "./jobs/parallel-finalization.js";

function loadEnvironment() {
  try {
    return readWorkerEnv(process.env);
  } catch (error) {
    const message =
      error instanceof EnvironmentValidationError ? error.message : "Invalid environment variables";
    console.error(message);
    process.exit(1);
  }
}

const environment = loadEnvironment();
if (environment.DATABASE_PROVIDER === "mysql") {
  console.error("DATABASE_PROVIDER: MySQL business repositories are unavailable until Phase 25");
  process.exit(1);
}
const prisma = createPrismaClient(environment.DATABASE_URL);
const repository = createUploadRepository(prisma);
const cleanupRepository = createCleanupRepository(prisma);
const orphanSweepRepository = createOrphanSweepRepository(prisma);
const passwordCleanupRepository = createPasswordCleanupRepository(prisma);
const observedStorage = observeObjectStoreActivity(
  createObjectStore({
    accessKeyId: environment.OBJECT_STORAGE_ACCESS_KEY_ID,
    accessKeySecret: environment.OBJECT_STORAGE_ACCESS_KEY_SECRET,
    bucket: environment.OBJECT_STORAGE_BUCKET,
    endpoint: environment.OBJECT_STORAGE_ENDPOINT,
    provider: environment.OBJECT_STORAGE_PROVIDER,
    region: environment.OBJECT_STORAGE_REGION,
    ...(environment.OBJECT_STORAGE_PUBLIC_ENDPOINT === undefined
      ? {}
      : { publicEndpoint: environment.OBJECT_STORAGE_PUBLIC_ENDPOINT }),
  }),
);
const storage = observedStorage.storage;
const telemetry = createTelemetry();
const app = buildWorkerApp({
  cleanupMetrics: () => cleanupRepository.getCleanupBacklog(),
  objectStorageMetrics: observedStorage.snapshot,
  telemetry,
});

await storage.ensurePrivateBucket();
let running = false;
const runJobs = async () => {
  if (running) return;
  running = true;
  try {
    await runMeasured("password_cleanup", async () => ({
      result: await runPasswordAccessCleanup({ repository: passwordCleanupRepository }),
    }));
    await runParallelFinalizers(environment.UPLOAD_FINALIZATION_CONCURRENCY, () => {
      let uploadTraceId: string | undefined;
      return runMeasured("upload_finalization", async () => ({
        result: await finalizeNextUpload({
          onOutcome: (outcome) => {
            uploadTraceId = outcome.traceId;
          },
          repository,
          storage,
          headObjectTimeoutMs: environment.UPLOAD_HEAD_OBJECT_TIMEOUT_MS,
        }),
        ...(uploadTraceId === undefined ? {} : { traceId: uploadTraceId }),
      }));
    });
    await runMeasured("cleanup", async () => ({
      result: await runNextCleanupJob({ repository: cleanupRepository, storage }),
    }));
    await runMeasured("orphan_sweep", async () => ({
      result: await runNextOrphanObjectSweep({
        listTimeoutMs: environment.UPLOAD_HEAD_OBJECT_TIMEOUT_MS,
        repository: orphanSweepRepository,
        storage,
      }),
    }));
  } catch {
    telemetry.record({ failed: true, name: "worker.loop.failure.INTERNAL" });
    app.log.error(
      redactLogValue({ failure_type: "INTERNAL", trace_id: createTraceId() }) as object,
      "worker job failed",
    );
  } finally {
    running = false;
  }
};

async function runMeasured(
  action: "cleanup" | "orphan_sweep" | "password_cleanup" | "upload_finalization",
  operation: () => Promise<{
    result: "completed" | "failed" | "idle" | "published" | "retry";
    traceId?: string;
  }>,
) {
  const startedAt = performance.now();
  let outcome: {
    result: "completed" | "failed" | "idle" | "published" | "retry";
    traceId?: string;
  };
  try {
    outcome = await operation();
  } catch {
    telemetry.record({ failed: true, name: `worker.${action}.failure.INTERNAL` });
    app.log.error(
      redactLogValue({ action, failure_type: "INTERNAL", trace_id: createTraceId() }) as object,
      "worker job failed",
    );
    throw new Error("worker job failed");
  }
  const { result, traceId: operationTraceId } = outcome;
  const traceId = createTraceId(operationTraceId);
  const milliseconds = Math.max(0, performance.now() - startedAt);
  const failed = result === "failed" || result === "retry";
  telemetry.record({
    failed,
    milliseconds,
    name: `worker.${action}.status.${result}`,
  });
  if (result === "idle") return result;
  app.log.info(
    redactLogValue({
      action,
      duration_ms: Math.round(milliseconds),
      result,
      trace_id: traceId,
    }) as object,
    "worker job completed",
  );
  return result;
}
const timer = setInterval(() => void runJobs(), 2_000);
timer.unref();
void runJobs();

app.addHook("onClose", async () => {
  await prisma.$disconnect();
});

try {
  await app.listen({
    host: environment.WORKER_HOST,
    port: environment.WORKER_PORT,
    listenTextResolver: () => "worker listening",
  });
} catch (error) {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "LISTEN_FAILED";
  app.log.error({ code }, "worker failed to start");
  process.exitCode = 1;
}
