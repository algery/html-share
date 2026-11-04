import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  assertSameDatabaseDeployment,
  checkDatabaseReadiness,
  createDatabaseClient,
  readRequiredDatabaseMigrations,
} from "../packages/db/dist/index.js";
import { verifyRestoredBusiness } from "./database-restore-business.mjs";

const models = [
  "databaseIdentity",
  "tenant",
  "user",
  "demoProject",
  "revision",
  "fileObject",
  "uploadFile",
  "uploadTask",
  "quotaReservation",
  "mcpToken",
  "accessSession",
  "authState",
  "passwordAccessGrant",
  "cleanupJob",
  "objectSweepState",
  "auditLog",
];
const docker = (args, input) => {
  const result = spawnSync("docker", args, { input, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0 || result.error)
    throw new Error("Isolated backup/restore command failed; output withheld");
  return result.stdout;
};

try {
  assert.equal(
    process.env.PHASE26_IMAGE_TEST_ISOLATED,
    "1",
    "Explicit image-test isolation required",
  );
  const results = [];
  for (const provider of ["postgresql", "mysql"]) {
    const configured =
      process.env[
        provider === "mysql" ? "PHASE26_MYSQL_CONTAINER_URL" : "PHASE26_POSTGRES_CONTAINER_URL"
      ];
    const url = new URL(configured ?? "invalid:");
    assert.equal(url.hostname, provider === "mysql" ? "phase26-mysql" : "phase26-pg");
    assert.equal(url.pathname, "/html_share_phase26_image");
    assert.equal(decodeURIComponent(url.username), "phase25");
    assert.equal(decodeURIComponent(url.password), "phase25-local-test");
    url.hostname = "127.0.0.1";
    url.port = provider === "mysql" ? "53319" : "55439";
    const source = createDatabaseClient({
      DATABASE_PROVIDER: provider,
      DATABASE_URL: url.toString(),
    });
    url.pathname = "/html_share_phase26_restore";
    const restored = createDatabaseClient({
      DATABASE_PROVIDER: provider,
      DATABASE_URL: url.toString(),
    });
    const snapshot = async (connection) => {
      const tables = await Promise.all(
        models.map((model) => connection.client[model].findMany({ orderBy: { id: "asc" } })),
      );
      return JSON.stringify(tables, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      );
    };
    try {
      // Restoring is destructive; require a genuinely empty dedicated target first.
      const tables =
        provider === "mysql"
          ? await restored.client
              .$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()`
          : await restored.client
              .$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`;
      assert.equal(tables.length, 0, "Restore target must be a fresh empty dedicated database");
      const before = await snapshot(source);
      assert(
        (await source.client.demoProject.count({
          where: { status: "ACTIVE", accessMode: "password" },
        })) > 0,
        "Backup source must contain an active password project",
      );
      const history = await source.client
        .$queryRaw`SELECT migration_name, checksum FROM _prisma_migrations ORDER BY migration_name`;
      let dump;
      if (provider === "postgresql") {
        dump = docker([
          "exec",
          "html-share-phase26-pg",
          "pg_dump",
          "-U",
          "phase25",
          "--format=custom",
          "--no-owner",
          "--no-privileges",
          "html_share_phase26_image",
        ]);
        docker(
          [
            "exec",
            "-i",
            "html-share-phase26-pg",
            "pg_restore",
            "-U",
            "phase25",
            "--no-owner",
            "--no-privileges",
            "-d",
            "html_share_phase26_restore",
          ],
          dump,
        );
      } else {
        const auth = ["-e", "MYSQL_PWD=phase25-local-test", "html-share-phase26-mysql"];
        dump = docker([
          "exec",
          ...auth,
          "mysqldump",
          "-uphase25",
          "--single-transaction",
          "--skip-lock-tables",
          "--no-tablespaces",
          "--set-gtid-purged=OFF",
          "html_share_phase26_image",
        ]);
        docker(["exec", "-i", ...auth, "mysql", "-uphase25", "html_share_phase26_restore"], dump);
      }
      assert.deepEqual(
        await snapshot(restored),
        before,
        "All restored business/identity metadata must match",
      );
      assert.deepEqual(
        await snapshot(source),
        before,
        "Backup and restore must not alter the source",
      );
      assert.deepEqual(
        await restored.client
          .$queryRaw`SELECT migration_name, checksum FROM _prisma_migrations ORDER BY migration_name`,
        history,
      );
      const required = await readRequiredDatabaseMigrations(provider);
      const identities = await Promise.all(
        [source, restored].map((connection) => checkDatabaseReadiness(connection, required)),
      );
      assert.equal(
        identities[0].instanceId,
        identities[1].instanceId,
        "Backup preserved its stored identity",
      );
      assert.throws(
        () => assertSameDatabaseDeployment(identities),
        "A restored copy in a different logical database must not masquerade as the original deployment target",
      );
      const business = await verifyRestoredBusiness({ provider, source, restored });
      assert.deepEqual(
        await snapshot(source),
        before,
        "Restored business operations cannot modify the source",
      );
      results.push({
        provider,
        models: models.length,
        dumpBytes: dump.length,
        sourceUnchanged: true,
        migrationChecksumsPreserved: true,
        restoredCopyDistinguished: true,
        business,
      });
    } finally {
      await Promise.all([source, restored].map((connection) => connection.client.$disconnect()));
    }
  }
  console.log(JSON.stringify({ status: "database-backup-restore-ok", results }));
} catch {
  console.error(
    "Database backup/restore smoke failed; require dedicated Phase 26 image sources and empty restore targets; raw output withheld",
  );
  process.exitCode = 1;
}
