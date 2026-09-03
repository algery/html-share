import { connect } from "node:net";

const RETRY_INTERVAL_MS = 500;
const MAX_ATTEMPTS = 60;

function loopbackHost(hostname) {
  return hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname;
}

function serverHealthUrl() {
  const host = process.env.APP_HOST;
  const port = process.env.SERVER_PORT;
  if (!host || !port) {
    throw new Error("APP_HOST and SERVER_PORT are required");
  }
  return `http://${loopbackHost(host)}:${port}/health/live`;
}

function workerHealthUrl() {
  const host = process.env.WORKER_HOST;
  const port = process.env.WORKER_PORT;
  if (!host || !port) {
    throw new Error("WORKER_HOST and WORKER_PORT are required");
  }
  return `http://${loopbackHost(host)}:${port}/health/live`;
}

function webHealthUrl() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    throw new Error("NEXT_PUBLIC_APP_URL is required");
  }
  return new URL("/api/health", appUrl).toString();
}

function minioHealthUrl() {
  const endpoint = process.env.OBJECT_STORAGE_ENDPOINT;
  if (!endpoint) {
    throw new Error("OBJECT_STORAGE_ENDPOINT is required");
  }
  return new URL("/minio/health/live", endpoint).toString();
}

function databaseAddress() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const parsed = new URL(databaseUrl);
  return {
    host: loopbackHost(parsed.hostname),
    port: Number(parsed.port || 5432),
  };
}

async function waitForHttp(name, url) {
  let lastError = "unreachable";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) {
        return { name, status: "ok", target: url };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "unknown error";
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
  }
  throw new Error(`${name} health check failed: ${lastError}`);
}

async function waitForTcp(name, host, port) {
  let lastError = "unreachable";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await new Promise((resolve, reject) => {
        const socket = connect({ host, port });
        socket.setTimeout(1_500);
        socket.once("connect", () => {
          socket.end();
          resolve();
        });
        socket.once("timeout", () => socket.destroy(new Error("timeout")));
        socket.once("error", reject);
      });
      return { name, status: "ok", target: `${host}:${port}` };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "unknown error";
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
  }
  throw new Error(`${name} health check failed: ${lastError}`);
}

const database = databaseAddress();
const checks = await Promise.all([
  waitForHttp("web", webHealthUrl()),
  waitForHttp("server", serverHealthUrl()),
  waitForHttp("worker", workerHealthUrl()),
  waitForHttp("minio", minioHealthUrl()),
  waitForTcp("postgres", database.host, database.port),
]);

console.log(JSON.stringify({ status: "ok", checks }, null, 2));
