import { checkDatabaseDeployment } from "./database-deployment-preflight.mjs";
import { readDeploymentDatabases } from "./database-deployment-config.mjs";
import { httpIsHealthy } from "./health-http.mjs";

const RETRY_INTERVAL_MS = 500;
const MAX_ATTEMPTS = 60;

function loopbackHost(hostname) {
  return hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname;
}

function serviceHealthUrl(service) {
  const host =
    service === "server"
      ? (process.env.SERVER_HOST ?? process.env.APP_HOST)
      : process.env.WORKER_HOST;
  const port = process.env[service === "server" ? "SERVER_PORT" : "WORKER_PORT"];
  if (!host || !port) throw new Error(`Missing ${service} health configuration`);
  return `http://${loopbackHost(host)}:${port}/health/ready`;
}

function configuredUrl(variable, path) {
  const value = process.env[variable];
  if (!value) throw new Error(`Missing ${variable} health configuration`);
  return new URL(path, value).toString();
}

async function waitForHttp(name, url, headers = {}) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      if (await httpIsHealthy(url, headers)) return { name, status: "ok" };
    } catch {
      // URLs, credentials and network diagnostics stay private.
    }
    if (attempt < MAX_ATTEMPTS)
      await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
  }
  throw new Error(`${name} health check failed; service is not ready`);
}

try {
  const targets = await readDeploymentDatabases(process.argv.slice(2));
  const database = await import("../packages/db/dist/index.js");
  await checkDatabaseDeployment(targets, database);
  const checks = await Promise.all([
    waitForHttp("web", configuredUrl("NEXT_PUBLIC_APP_URL", "/api/health")),
    waitForHttp("server", serviceHealthUrl("server"), { host: process.env.APP_HOST }),
    waitForHttp("worker", serviceHealthUrl("worker")),
    waitForHttp("minio", configuredUrl("OBJECT_STORAGE_ENDPOINT", "/minio/health/live")),
  ]);
  console.log(
    JSON.stringify(
      { status: "ok", checks: [{ name: "database", status: "ok" }, ...checks] },
      null,
      2,
    ),
  );
} catch {
  console.error(
    "Health check failed; verify database deployment, service readiness and object storage configuration",
  );
  process.exitCode = 1;
}
