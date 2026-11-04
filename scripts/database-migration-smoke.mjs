import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  checkDatabaseReadiness,
  createDatabaseClient,
  readRequiredDatabaseMigrations,
} from "../packages/db/dist/index.js";
import { isolatedUrl, providers, runCaptured } from "./database-compatibility-support.mjs";
import { runPrisma } from "./database-command.mjs";

const connections = [];
const markers = [];
let assertions = 0;
function check(condition, message) {
  assert(condition, message);
  assertions++;
}
const stable = (value) =>
  JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry));
async function history(client) {
  return client.$queryRaw`SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name`;
}
async function snapshot(client) {
  const names = [
    "tenant",
    "user",
    "demoProject",
    "revision",
    "fileObject",
    "mcpToken",
    "accessSession",
    "uploadTask",
    "auditLog",
    "cleanupJob",
    "databaseIdentity",
    "passwordAccessGrant",
    "uploadFile",
    "quotaReservation",
    "authState",
    "objectSweepState",
  ];
  const result = {};
  for (const name of names) result[name] = await client[name].findMany({ orderBy: { id: "asc" } });
  result.history = await history(client);
  return stable(result);
}
try {
  const environments = providers.map((provider) => ({
    DATABASE_PROVIDER: provider,
    DATABASE_URL: isolatedUrl(
      process.env[`PHASE26_${provider === "mysql" ? "MYSQL" : "POSTGRES"}_MIGRATION_URL`],
      provider,
      /^html_share_phase26_empty[a-z0-9_]*$/,
    ),
  }));
  const upgradeUrl = isolatedUrl(
    process.env.PHASE26_POSTGRES_UPGRADE_URL,
    "postgresql",
    /^html_share_phase24_upgrade[a-z0-9_]*$/,
  );
  check(
    new Set([
      ...environments.map(
        (env) => `${env.DATABASE_PROVIDER}:${new URL(env.DATABASE_URL).pathname}`,
      ),
      `postgresql:${new URL(upgradeUrl).pathname}`,
    ]).size === 3,
    "Migration/upgrade targets have distinct isolated names",
  );
  for (const env of environments) {
    const connection = createDatabaseClient(env);
    connections.push(connection);
    const tables =
      env.DATABASE_PROVIDER === "mysql"
        ? await connection.client
            .$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()`
        : await connection.client
            .$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    check(
      tables.length === 0,
      "First deployment requires an actually empty dedicated database; no reset performed",
    );
    // Verify omitted provider still follows the PostgreSQL migration path.
    const deployEnvironment =
      env.DATABASE_PROVIDER === "postgresql"
        ? { DATABASE_PROVIDER: undefined, DATABASE_URL: env.DATABASE_URL }
        : env;
    runPrisma(["migrate", "deploy"], deployEnvironment);
    const readiness = await checkDatabaseReadiness(
      connection,
      await readRequiredDatabaseMigrations(connection.provider),
    );
    check(
      readiness.provider === env.DATABASE_PROVIDER,
      "First deploy initializes the selected provider",
    );
    const firstHistory = await history(connection.client);
    check(
      firstHistory.length > 0 &&
        firstHistory.every((row) => row.finished_at && !row.rolled_back_at),
      "All provider migrations applied",
    );
    runPrisma(["migrate", "deploy"], deployEnvironment);
    check(
      stable(await history(connection.client)) === stable(firstHistory),
      "Repeat deploy preserves migration checksums and timestamps",
    );
    const ownMigration =
      env.DATABASE_PROVIDER === "mysql"
        ? "20261104000000_mysql_initial"
        : "20261104000000_database_identity";
    check(
      firstHistory.some((row) => row.migration_name === ownMigration),
      "Provider-specific migration history exists",
    );
  }
  const [postgres, mysql] = connections;
  for (const [source, target] of [
    [postgres, mysql],
    [mysql, postgres],
  ]) {
    const tenant = await source.client.tenant.create({
      data: { name: "Phase26 retained source 中文😀", dingtalkAppKeyRef: randomUUID() },
    });
    markers.push({ client: source.client, id: tenant.id });
    check(
      (await target.client.tenant.count()) === 0,
      "Switched target is a genuinely empty business database",
    );
    const before = await snapshot(source.client);
    const targetBefore = await snapshot(target.client);
    // Selecting an already initialized empty target must neither copy nor modify the source.
    runPrisma(
      ["migrate", "deploy"],
      environments.find((env) => env.DATABASE_PROVIDER === target.provider),
    );
    await checkDatabaseReadiness(target, await readRequiredDatabaseMigrations(target.provider));
    check(
      (await snapshot(source.client)) === before,
      "Environment switch leaves original data, identity and migration history unchanged",
    );
    check(
      (await snapshot(target.client)) === targetBefore,
      "Target initialization performs no automatic copy or dual write",
    );
    check(
      (await target.client.tenant.count()) === 0,
      "Target does not inherit source business records",
    );
    await source.client.tenant.delete({ where: { id: tenant.id } });
    markers.pop();
  }
  runCaptured("scripts/database-upgrade-smoke.mjs", {
    DATABASE_PROVIDER: "postgresql",
    DATABASE_URL: upgradeUrl,
    DATABASE_TEST_ISOLATED: "1",
  });
  check(
    true,
    "Existing PostgreSQL upgrade smoke preserves full business snapshot and applied checksums",
  );
  console.log(
    JSON.stringify({
      status: "database-migration-smoke-ok",
      assertions,
      providers,
      firstAndRepeat: true,
      retainedSources: true,
      postgresUpgrade: true,
      automaticTransfer: false,
    }),
  );
} catch {
  console.error(
    "Migration smoke failed; requires fresh local html_share_phase26_empty* databases and a fresh html_share_phase24_upgrade* database; original targets are never reset",
  );
  process.exitCode = 1;
} finally {
  for (const { client, id } of markers) await client.tenant.delete({ where: { id } });
  for (const connection of connections) await connection.client.$disconnect();
}
