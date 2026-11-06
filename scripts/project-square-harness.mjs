import { createSquareService } from "../packages/core/dist/index.js";
import { readContractDatabases } from "../packages/db/dist/testing/database-fixture.js";

export function squareHarnessOptions(options, repositories, demoWebUrl) {
  if (!options.squareDirectory) return {};
  return {
    directory: options.squareDirectory,
    square: createSquareService({
      repository: repositories.square,
      directory: options.squareDirectory,
      demoWebUrl,
    }),
  };
}

export function squareSmokeConfiguration(provider) {
  const configuration = readContractDatabases().find((item) => item.DATABASE_PROVIDER === provider);
  if (
    !configuration ||
    !process.env.PHASE30_MINIO_ACCESS_KEY_ID ||
    !process.env.PHASE30_MINIO_ACCESS_KEY_SECRET
  ) {
    throw new Error("Both isolated databases and Phase 30 MinIO credentials are required");
  }
  return {
    databaseProvider: provider,
    databaseUrl: configuration.DATABASE_URL,
    endpoint: "http://127.0.0.1:59010",
    accessKeyId: process.env.PHASE30_MINIO_ACCESS_KEY_ID,
    accessKeySecret: process.env.PHASE30_MINIO_ACCESS_KEY_SECRET,
  };
}

export async function squareSession(h, code, audience = "app") {
  const host = audience === "app" ? "127.0.0.1" : "localhost";
  const started = await h.app.inject({
    method: "POST",
    url: "/auth/internal/start",
    headers: { host, accept: "application/json" },
    payload: { returnPath: audience === "app" ? "/square" : "/abc12/index.html" },
  });
  const completed = await h.app.inject({
    method: "POST",
    url: "/auth/internal/complete",
    headers: { host, accept: "application/json" },
    payload: { code, state: started.json().state },
  });
  if (completed.statusCode !== 200) throw new Error("Synthetic organization login failed");
  const raw = completed.headers["set-cookie"];
  return (Array.isArray(raw) ? raw[0] : raw).split(";")[0];
}
