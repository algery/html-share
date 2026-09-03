import { EnvironmentValidationError, readWorkerEnv } from "@html-share/config";
import { createPrismaClient, createUploadRepository } from "@html-share/db";
import { createObjectStore } from "@html-share/storage";

import { buildWorkerApp } from "./app.js";
import { cleanupUploadArtifacts, finalizeNextUpload } from "./jobs/finalize-upload.js";

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
const prisma = createPrismaClient(environment.DATABASE_URL);
const repository = createUploadRepository(prisma);
const storage = createObjectStore({
  accessKeyId: environment.OBJECT_STORAGE_ACCESS_KEY_ID,
  accessKeySecret: environment.OBJECT_STORAGE_ACCESS_KEY_SECRET,
  bucket: environment.OBJECT_STORAGE_BUCKET,
  endpoint: environment.OBJECT_STORAGE_ENDPOINT,
  provider: environment.OBJECT_STORAGE_PROVIDER,
  region: environment.OBJECT_STORAGE_REGION,
  ...(environment.OBJECT_STORAGE_PUBLIC_ENDPOINT === undefined
    ? {}
    : { publicEndpoint: environment.OBJECT_STORAGE_PUBLIC_ENDPOINT }),
});
const app = buildWorkerApp();

await storage.ensurePrivateBucket();
let running = false;
const runJobs = async () => {
  if (running) return;
  running = true;
  try {
    await finalizeNextUpload({ repository, storage });
    await cleanupUploadArtifacts({ repository, storage });
  } finally {
    running = false;
  }
};
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
