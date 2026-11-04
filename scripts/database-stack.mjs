import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readDatabaseEnv } from "../packages/config/src/database-environment.ts";

const workspace = fileURLToPath(new URL("../", import.meta.url));

export function containerDatabaseEnvironment(environment) {
  const input = { ...environment };
  if (input.CONTAINER_DATABASE_URL !== undefined) {
    input.DATABASE_URL = input.CONTAINER_DATABASE_URL;
  }
  const database = readDatabaseEnv(input);
  const url = new URL(database.DATABASE_URL);
  const mysql = database.DATABASE_PROVIDER === "mysql";
  const local = mysql
    ? {
        user: input.MYSQL_USER ?? "html_share",
        password: input.MYSQL_PASSWORD ?? "html_share_local",
        name: input.MYSQL_DATABASE ?? "html_share",
        port: input.MYSQL_PORT ?? "3306",
        host: "mysql",
      }
    : {
        user: input.POSTGRES_USER ?? "html_share",
        password: input.POSTGRES_PASSWORD ?? "html_share_local",
        name: input.POSTGRES_DB ?? "html_share",
        port: input.POSTGRES_PORT ?? "5432",
        host: "postgres",
      };
  const localTarget =
    input.CONTAINER_DATABASE_URL === undefined &&
    input.LOCAL_DATABASE_CONTAINER_OVERRIDE !== "true" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    decodeURIComponent(url.username) === local.user &&
    decodeURIComponent(url.password) === local.password &&
    decodeURIComponent(url.pathname.slice(1)) === local.name &&
    (url.port || (mysql ? "3306" : "5432")) === local.port &&
    !url.searchParams.has("host");
  if (localTarget) {
    url.hostname = local.host;
    url.port = mysql ? "3306" : "5432";
    database.DATABASE_URL = url.toString();
  }
  return { ...input, ...database };
}

export function stackCommand(action, environment, envFile) {
  const database = readDatabaseEnv(environment);
  const file = database.DATABASE_PROVIDER === "mysql" ? "compose.mysql.yaml" : "compose.yaml";
  const base = ["compose", "--env-file", envFile, "-f", file];
  if (action === "infra-up") {
    return [
      ...base,
      "up",
      "-d",
      "--wait",
      database.DATABASE_PROVIDER === "mysql" ? "mysql" : "postgres",
      "minio",
    ];
  }
  if (action === "down") return [...base, "down"];
  if (action === "up") return [...base, "up", "-d", "--build", "--force-recreate", "--wait"];
  if (action === "config") return [...base, "config"];
  throw new Error("Expected infra-up, down, up or config");
}

export function stackDeploymentCommands(action, environment, envFile) {
  const command = stackCommand(action, environment, envFile);
  // Old roles stop before a fresh migration nonce can approve another target.
  return action === "up"
    ? [[...command.slice(0, 5), "stop", "server", "worker"], command]
    : [command];
}

function run(command, arguments_, environment) {
  return new Promise((resolveResult) => {
    const child = spawn(command, arguments_, {
      cwd: process.argv[2] === "--exec" ? process.cwd() : workspace,
      env: environment,
      stdio: "inherit",
    });
    const stop = (signal) => child.kill(signal);
    const terminate = () => stop("SIGTERM");
    const interrupt = () => stop("SIGINT");
    process.on("SIGTERM", terminate);
    process.on("SIGINT", interrupt);
    child.once("error", () => {
      console.error("Database stack command could not start");
    });
    child.once("close", (code, signal) => {
      process.removeListener("SIGTERM", terminate);
      process.removeListener("SIGINT", interrupt);
      resolveResult(signal ? 1 : (code ?? 1));
    });
  });
}

async function main() {
  const [action, ...arguments_] = process.argv.slice(2);
  if (action === "--exec") {
    const [command, ...commandArguments] = arguments_;
    if (!command) throw new Error("Missing container command");
    process.exitCode = await run(
      command,
      commandArguments,
      containerDatabaseEnvironment(process.env),
    );
    return;
  }
  const envArgument = arguments_.find((argument) => argument.startsWith("--env-file="));
  if (arguments_.some((argument) => argument !== envArgument)) {
    throw new Error("Expected --env-file=PATH");
  }
  const envFile = resolve(workspace, envArgument?.slice("--env-file=".length) ?? ".env.example");
  const environment = { ...parseEnv(readFileSync(envFile, "utf8")), ...process.env };
  for (const command of stackDeploymentCommands(action, environment, envFile)) {
    process.exitCode = await run("docker", command, environment);
    if (process.exitCode !== 0) return;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch {
    // Commands, URLs and driver diagnostics can contain credentials.
    console.error(
      "Database stack failed; check provider, URL, environment file and Docker availability",
    );
    process.exitCode = 1;
  }
}
