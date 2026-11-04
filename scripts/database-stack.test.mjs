import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { parseEnv } from "node:util";
import {
  containerDatabaseEnvironment,
  stackCommand,
  stackDeploymentCommands,
} from "./database-stack.mjs";

const postgres = {
  DATABASE_URL: "postgresql://html_share:html_share_local@localhost:5432/html_share?schema=public",
};
const mysql = {
  DATABASE_PROVIDER: "mysql",
  DATABASE_URL: "mysql://html_share:html_share_local@localhost:3306/html_share",
};

test("legacy PostgreSQL and explicit MySQL select a complete exclusive topology", () => {
  assert.deepEqual(stackCommand("infra-up", postgres, ".env"), [
    "compose",
    "--env-file",
    ".env",
    "-f",
    "compose.yaml",
    "up",
    "-d",
    "--wait",
    "postgres",
    "minio",
  ]);
  assert.deepEqual(stackCommand("infra-up", mysql, ".env"), [
    "compose",
    "--env-file",
    ".env",
    "-f",
    "compose.mysql.yaml",
    "up",
    "-d",
    "--wait",
    "mysql",
    "minio",
  ]);
  assert.equal(stackCommand("up", mysql, ".env").includes("--wait"), true);
  assert.equal(stackCommand("down", mysql, ".env").includes("-v"), false);
});

test("container routes translate only the complete documented local target", () => {
  assert.equal(new URL(containerDatabaseEnvironment(postgres).DATABASE_URL).hostname, "postgres");
  assert.equal(new URL(containerDatabaseEnvironment(mysql).DATABASE_URL).hostname, "mysql");
  const isolated = {
    ...mysql,
    MYSQL_PORT: "23306",
    DATABASE_URL: mysql.DATABASE_URL.replace(":3306/", ":23306/"),
  };
  assert.equal(new URL(containerDatabaseEnvironment(isolated).DATABASE_URL).port, "3306");
  for (const DATABASE_URL of [
    postgres.DATABASE_URL.replace("localhost", "db.example.com"),
    postgres.DATABASE_URL.replace("html_share_local", "external_password"),
    postgres.DATABASE_URL.replace("/html_share?", "/other_database?"),
    postgres.DATABASE_URL.replace(":5432/", ":15432/"),
    `${postgres.DATABASE_URL}&host=/var/run/postgresql`,
  ]) {
    assert.equal(containerDatabaseEnvironment({ DATABASE_URL }).DATABASE_URL, DATABASE_URL);
  }
});

test("explicit container routes and non-database settings remain untouched", () => {
  const override = "postgresql://html_share:html_share_local@localhost:5432/html_share";
  assert.equal(
    containerDatabaseEnvironment({ ...postgres, CONTAINER_DATABASE_URL: override }).DATABASE_URL,
    override,
  );
  assert.equal(
    containerDatabaseEnvironment({ ...postgres, LOCAL_DATABASE_CONTAINER_OVERRIDE: "true" })
      .DATABASE_URL,
    postgres.DATABASE_URL,
  );
  assert.equal(
    containerDatabaseEnvironment({ ...mysql, OBJECT_STORAGE_PROVIDER: "oss" })
      .OBJECT_STORAGE_PROVIDER,
    "oss",
  );
});

test("invalid provider, URL or override fails without fallback", () => {
  for (const environment of [
    { ...postgres, DATABASE_PROVIDER: "" },
    { ...postgres, DATABASE_PROVIDER: "sqlite" },
    { ...mysql, DATABASE_URL: postgres.DATABASE_URL },
    { ...postgres, DATABASE_URL: "" },
    { ...postgres, CONTAINER_DATABASE_URL: "" },
    { DATABASE_PROVIDER: "mysql" },
  ]) {
    assert.throws(() => containerDatabaseEnvironment(environment), /Invalid environment variables/);
  }
});

test("both examples route locally and every topology blocks apps on migration plus SQL preflight", () => {
  for (const [name, host] of [
    [".env.example", "postgres"],
    [".env.mysql.example", "mysql"],
  ]) {
    const environment = parseEnv(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));
    assert.equal(new URL(containerDatabaseEnvironment(environment).DATABASE_URL).hostname, host);
  }
  for (const name of [
    "compose.yaml",
    "compose.mysql.yaml",
    "compose.production.yaml",
    "compose.1panel.yaml",
  ]) {
    const content = readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
    assert.match(content, /db:migrate:deploy && node scripts\/database-deployment-preflight\.mjs/);
    assert.match(content, /service_completed_successfully/);
    assert.match(content, /--write-target=\/deployment-target\/target.json/);
    assert.equal((content.match(/deployment-targets:\/deployment-target/g) ?? []).length, 4);
    assert.match(content, /DATABASE_DEPLOYMENT_TARGET_FILE: \/deployment-target\/target.json/);
    assert.match(content, /chown node:node \/deployment-target/);
    assert.match(content, /health\/ready/);
    assert.doesNotMatch(content, /health\/live/);
    assert.match(content, /3001\/health\/ready.*headers:\{host:process\.env\.APP_HOST\}/);
  }
  assert.doesNotMatch(
    readFileSync(new URL("../compose.mysql.yaml", import.meta.url), "utf8"),
    /^ {2}postgres:/m,
  );
});

test("runtime wrapper passes the selected URL and preserves child exit status", () => {
  const script = new URL("./database-stack.mjs", import.meta.url).pathname;
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--exec",
      process.execPath,
      "-e",
      "process.exit(new URL(process.env.DATABASE_URL).hostname === 'mysql' ? 7 : 9)",
    ],
    { env: { ...process.env, ...mysql }, encoding: "utf8" },
  );
  assert.equal(result.status, 7);
  const invalid = spawnSync(
    process.execPath,
    [script, "--exec", process.execPath, "-e", "process.exit(0)"],
    {
      env: {
        ...process.env,
        ...mysql,
        DATABASE_PROVIDER: "",
        DATABASE_URL: "mysql://secret:password@bad.invalid/db",
      },
      encoding: "utf8",
    },
  );
  assert.equal(invalid.status, 1);
  assert.doesNotMatch(invalid.stderr, /secret|password|bad.invalid/);
});

test("deployment stops both old roles before force-recreating migration and consumers", () => {
  const commands = stackDeploymentCommands("up", mysql, ".env");
  assert.deepEqual(commands[0], [
    "compose",
    "--env-file",
    ".env",
    "-f",
    "compose.mysql.yaml",
    "stop",
    "server",
    "worker",
  ]);
  assert.equal(commands[1].includes("--force-recreate"), true);
  assert.equal(commands[1].includes("--wait"), true);
});

test("orchestration never starts a new deployment when stopping old roles fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "database-stack-test-"));
  const executable = join(directory, "docker");
  const log = join(directory, "calls.log");
  writeFileSync(
    executable,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$STACK_LOG"\nif [ "$6" = "stop" ] && [ "$FAIL_STOP" = "1" ]; then exit 17; fi\n',
  );
  chmodSync(executable, 0o700);
  const script = new URL("./database-stack.mjs", import.meta.url).pathname;
  const env = {
    ...process.env,
    ...mysql,
    PATH: `${directory}:${process.env.PATH}`,
    STACK_LOG: log,
  };
  try {
    const failed = spawnSync(process.execPath, [script, "up", "--env-file=.env.mysql.example"], {
      env: { ...env, FAIL_STOP: "1" },
      encoding: "utf8",
    });
    assert.equal(failed.status, 17);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
    writeFileSync(log, "");
    const successful = spawnSync(
      process.execPath,
      [script, "up", "--env-file=.env.mysql.example"],
      { env, encoding: "utf8" },
    );
    assert.equal(successful.status, 0);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(calls.length, 2);
    assert.match(calls[0], /stop server worker$/);
    assert.match(calls[1], /up -d --build --force-recreate --wait$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the actual Compose probes preserve Host through native HTTP and reject unready status", () => {
  for (const name of [
    "compose.yaml",
    "compose.mysql.yaml",
    "compose.production.yaml",
    "compose.1panel.yaml",
  ]) {
    const content = readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
    const line = content.split("\n").find((value) => value.includes("127.0.0.1:3001/health/ready"));
    assert.ok(line);
    const probe = JSON.parse(line.trim().replace(/,$/, ""));
    const echo = `
      const {createServer} = require('node:http');
      const {spawn} = require('node:child_process');
      let observed;
      const server = createServer((request, response) => {
        observed = {host: request.headers.host, path: request.url};
        response.statusCode = request.headers.host === process.env.APP_HOST ? Number(process.env.ECHO_STATUS) : 404;
        response.end();
      });
      server.listen(0, '127.0.0.1', () => {
        const probe = ${JSON.stringify(probe)}.replace('127.0.0.1:3001', '127.0.0.1:' + server.address().port);
        const child = spawn(process.execPath, ['-e', probe], {env: process.env});
        child.on('close', code => server.close(() => {
          console.log(JSON.stringify({...observed, probeExit: code}));
        }));
      });
    `;
    for (const [status, expectedExit] of [
      [200, 0],
      [503, 1],
    ]) {
      const result = spawnSync(process.execPath, ["-e", echo], {
        env: { ...process.env, APP_HOST: "app.probe.test", ECHO_STATUS: String(status) },
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        host: "app.probe.test",
        path: "/health/ready",
        probeExit: expectedExit,
      });
    }
  }
});
