import { execFile } from "node:child_process";
import { parseEnv, promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { exerciseDatabaseImage } from "./database-image-http.mjs";
import { rejectMismatchedImage } from "./database-image-rejection.mjs";
import { imageRequest } from "./database-image-request.mjs";
import { verifyOfflineImages } from "./database-image-offline.mjs";

const execute = promisify(execFile);
const network = "html-share-phase26-test";
const names = [];
const docker = async (...args) => {
  try {
    return (
      await execute("docker", args, { timeout: 180_000, maxBuffer: 1024 * 1024 })
    ).stdout.trim();
  } catch {
    throw new Error(
      "Isolated database image command failed; inspect the dedicated test containers",
    );
  }
};

try {
  if (process.env.PHASE26_IMAGE_TEST_ISOLATED !== "1")
    throw new Error("Explicit image-test isolation is required");
  const server = process.env.PHASE26_SERVER_IMAGE;
  const worker = process.env.PHASE26_WORKER_IMAGE;
  if (
    !/^html-share-server:phase26[a-z0-9.-]*$/.test(server ?? "") ||
    !/^html-share-worker:phase26[a-z0-9.-]*$/.test(worker ?? "")
  )
    throw new Error("Dedicated Phase 26 image tags are required");
  const imageIds = await Promise.all(
    [server, worker].map((image) => docker("image", "inspect", "--format", "{{.Id}}", image)),
  );
  await docker(
    "run",
    "--rm",
    "--user",
    "0",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CHOWN",
    "-v",
    "html-share-phase26-image-targets:/deployment-target",
    server,
    "sh",
    "-c",
    "mkdir -p /deployment-target && chown 1000:1000 /deployment-target",
  );
  const defaults = parseEnv(await readFile(new URL("../.env.example", import.meta.url), "utf8"));
  const results = [];
  for (const provider of ["postgresql", "mysql"]) {
    const databaseUrl =
      process.env[
        provider === "mysql" ? "PHASE26_MYSQL_CONTAINER_URL" : "PHASE26_POSTGRES_CONTAINER_URL"
      ];
    const url = new URL(databaseUrl ?? "invalid:");
    if (
      url.hostname !== (provider === "mysql" ? "phase26-mysql" : "phase26-pg") ||
      url.pathname !== "/html_share_phase26_image" ||
      url.protocol !== (provider === "mysql" ? "mysql:" : "postgresql:")
    )
      throw new Error("Dedicated Phase 26 container database targets are required");
    const environment = {
      ...defaults,
      DATABASE_PROVIDER: provider,
      DATABASE_URL: databaseUrl,
      SERVER_HOST: "0.0.0.0",
      WORKER_HOST: "0.0.0.0",
      WORKER_PORT: "3002",
      APP_AUTH_URL: "http://app.localhost:55531",
      APP_WEB_URL: "http://app.localhost:55530",
      DEMO_AUTH_URL: "http://demo.localhost:55531",
      DEMO_WEB_URL: "http://demo.localhost:55531",
      OBJECT_STORAGE_ENDPOINT: "http://phase26-minio:9000",
      OBJECT_STORAGE_PUBLIC_ENDPOINT: "http://127.0.0.1:59000",
      OBJECT_STORAGE_BUCKET: `phase26-image-${provider}`,
      OBJECT_STORAGE_ACCESS_KEY_ID: "password_test",
      OBJECT_STORAGE_ACCESS_KEY_SECRET: "local-password-test-only",
      DINGTALK_AUTH_MODE: "simulator",
      UPLOAD_FINALIZATION_CONCURRENCY: "10",
      DATABASE_DEPLOYMENT_TARGET_FILE: "/deployment-target/target.json",
      MCP_RATE_LIMIT_PER_MINUTE: "1000",
      MCP_UPLOAD_COMPLETE_RATE_LIMIT_PER_MINUTE: "1000",
      MCP_UPLOAD_PREPARE_RATE_LIMIT_PER_MINUTE: "1000",
    };
    const envArgs = Object.entries(environment).flatMap(([key, value]) => [
      "-e",
      `${key}=${value}`,
    ]);
    const offline = await verifyOfflineImages({ docker, envArgs, server, worker, provider, names });
    const common = [
      "--network",
      network,
      "--read-only",
      "--tmpfs",
      "/tmp",
      "--cap-drop",
      "ALL",
      "-v",
      "html-share-phase26-image-targets:/deployment-target",
    ];
    await docker(
      "run",
      "--rm",
      ...common,
      ...envArgs,
      server,
      "node",
      "/workspace/scripts/database-migrate.mjs",
    );
    await docker(
      "run",
      "--rm",
      ...common,
      ...envArgs,
      server,
      "node",
      "/workspace/scripts/database-deployment-preflight.mjs",
      "--write-target=/deployment-target/target.json",
    );
    for (const [role, image, port, internal] of [
      ["server", server, 55531, 3001],
      ["worker", worker, 55532, 3002],
    ]) {
      const name = `html-share-phase26-image-${provider}-${role}`;
      names.push(name);
      await docker(
        "run",
        "-d",
        "--name",
        name,
        ...common,
        "--cpus=1",
        "--memory=768m",
        "-p",
        `127.0.0.1:${port}:${internal}`,
        ...envArgs,
        image,
      );
    }
    for (const [role, port] of [
      ["server", 55531],
      ["worker", 55532],
    ]) {
      const name = `html-share-phase26-image-${provider}-${role}`;
      let ready = false;
      for (let attempt = 0; attempt < 350; attempt++) {
        try {
          ready = (
            role === "server"
              ? await imageRequest("/health/ready")
              : await fetch(`http://127.0.0.1:${port}/health/ready`, {
                  signal: AbortSignal.timeout(1000),
                })
          ).ok;
        } catch {
          // Startup may not have opened the listener yet.
        }
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!ready) throw new Error(`${role} image readiness failed (${provider})`);
      const actual = await docker("inspect", "--format", "{{.Image}}", name);
      if (actual !== imageIds[role === "server" ? 0 : 1])
        throw new Error("Image identity mismatch");
    }
    const business = await exerciseDatabaseImage();
    await docker("rm", "-f", ...names.splice(0));
    const rejection = await rejectMismatchedImage({
      docker,
      common,
      envArgs,
      provider,
      server,
      worker,
      databaseUrl,
      names,
    });
    results.push({
      provider,
      offline,
      ...business,
      ...rejection,
      serverImage: imageIds[0],
      workerImage: imageIds[1],
    });
    await docker("rm", "-f", ...names.splice(0));
  }
  console.log(JSON.stringify({ status: "database-image-smoke-ok", results }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Database image smoke failed");
  process.exitCode = 1;
} finally {
  if (names.length) await docker("rm", "-f", ...names).catch(() => undefined);
}
