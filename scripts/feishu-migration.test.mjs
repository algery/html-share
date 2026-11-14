import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createDatabaseClient } from "../packages/db/src/database-client.ts";
import { createDatabaseRepositories } from "../packages/db/src/database-repositories.ts";
import { isolatedUrl } from "./database-compatibility-support.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const newest = "20261114000000_feishu_identity";
const enabled = Boolean(
  process.env.PHASE39_POSTGRES_MIGRATION_URL || process.env.PHASE39_MYSQL_MIGRATION_URL,
);
const run = enabled ? it : it.skip;
function deploy(config, env) {
  const result = spawnSync(
    process.execPath,
    [join(root, "node_modules/prisma/build/index.js"), "migrate", "deploy", "--config", config],
    { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" },
  );
  // Keep database URLs and raw diagnostics out of test output.
  if (result.status !== 0) throw new Error("Isolated migration deploy failed");
}
for (const provider of ["postgresql", "mysql"]) {
  run(
    `${provider}: upgrades legacy assets and re-applies Feishu migrations without changing them`,
    async () => {
      const variable =
        provider === "mysql" ? "PHASE39_MYSQL_MIGRATION_URL" : "PHASE39_POSTGRES_MIGRATION_URL";
      const url = isolatedUrl(process.env[variable], provider, /^html_share_phase39_[a-z0-9_]+$/);
      const env = { DATABASE_PROVIDER: provider, DATABASE_URL: url };
      const connection = createDatabaseClient(env);
      const db = connection.client;
      const temporary = await mkdtemp(join(tmpdir(), "html-share-feishu-migration-"));
      const source = join(root, "packages/db", provider === "mysql" ? "prisma-mysql" : "prisma");
      const migrations = join(temporary, "migrations");
      try {
        const tables =
          provider === "mysql"
            ? await db.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()`
            : await db.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
        expect(tables).toHaveLength(0);
        await mkdir(migrations);
        for (const entry of await readdir(join(source, "migrations"))) {
          if (entry !== newest)
            await cp(join(source, "migrations", entry), join(migrations, entry), {
              recursive: true,
            });
        }
        const config = join(temporary, "prisma.config.ts");
        await writeFile(
          config,
          `export default {schema:${JSON.stringify(source)},migrations:{path:${JSON.stringify(migrations)}},datasource:{url:process.env.DATABASE_URL}};`,
        );
        deploy(config, env);
        const tenant = await db.tenant.create({
          data: { name: "legacy migration", dingtalkAppKeyRef: randomUUID() },
        });
        const user = await db.user.create({
          data: {
            tenantId: tenant.id,
            dingtalkUserId: randomUUID(),
            displayName: "Legacy",
            lastLoginAt: new Date("2026-11-01T00:00:00.123Z"),
          },
        });
        const project = await db.demoProject.create({
          data: {
            tenantId: tenant.id,
            ownerUserId: user.id,
            projectKey: "old01",
            displayName: "legacy Demo",
            totalSize: 123n,
          },
        });
        const revision = await db.revision.create({
          data: { tenantId: tenant.id, projectId: project.id, revisionNumber: 1, status: "ACTIVE" },
        });
        const task = await db.uploadTask.create({
          data: {
            tenantId: tenant.id,
            ownerUserId: user.id,
            projectId: project.id,
            revisionId: revision.id,
            action: "CREATE",
            displayName: "legacy",
            targetHtml: "index.html",
            declaredFileCount: 1,
            declaredTotalSize: 123n,
            manifestDigest: "a".repeat(64),
            clientRequestId: randomUUID(),
            expiresAt: new Date("2030-01-01T00:00:00.123Z"),
          },
        });
        await db.quotaReservation.create({
          data: {
            tenantId: tenant.id,
            userId: user.id,
            uploadTaskId: task.id,
            projectDelta: 1,
            storageBytes: 123n,
            expiresAt: task.expiresAt,
          },
        });
        await db.mcpToken.create({
          data: {
            userId: user.id,
            name: "legacy token",
            tokenDigest: randomUUID(),
            tokenSuffix: "abcd",
            expiresAt: new Date("2030-01-01T00:00:00.123Z"),
          },
        });
        const names = [
          "tenant",
          "user",
          "demoProject",
          "revision",
          "uploadTask",
          "quotaReservation",
          "mcpToken",
        ];
        async function snapshot() {
          return Promise.all(names.map((name) => db[name].findMany({ orderBy: { id: "asc" } })));
        }
        const before = await snapshot();
        await cp(join(source, "migrations", newest), join(migrations, newest), { recursive: true });
        deploy(config, env);
        expect(await snapshot()).toEqual(before);
        expect(await db.feishuIdentity.count()).toBe(0);
        expect(await db.accountContact.count()).toBe(0);
        deploy(config, env);
        const sql = await readFile(join(source, "migrations", newest, "migration.sql"), "utf8");
        for (const statement of sql
          .split(";")
          .map((part) => part.trim())
          .filter(Boolean))
          await db.$executeRawUnsafe(statement);
        expect(await snapshot()).toEqual(before);
        const repository = createDatabaseRepositories(connection).auth;
        const identity = {
          tenantAppKeyRef: tenant.dingtalkAppKeyRef,
          now: new Date(),
          displayName: "legacy",
          email: "legacy@example.com",
        };
        await repository.upsertUser({ ...identity, dingtalkUserId: user.dingtalkUserId });
        expect(
          await repository.upsertFeishuUser({
            ...identity,
            feishuAppId: "app",
            feishuTenantKey: "tenant",
            feishuOpenId: "open",
          }),
        ).toEqual({ id: user.id });
        expect((await snapshot()).slice(2)).toEqual(before.slice(2));
        const independent = await repository.upsertFeishuUser({
          ...identity,
          email: undefined,
          feishuAppId: "app",
          feishuTenantKey: "tenant",
          feishuOpenId: "independent",
        });
        expect(
          (await db.user.findUniqueOrThrow({ where: { id: independent.id } })).dingtalkUserId,
        ).toBeNull();
      } finally {
        await db.$disconnect();
        await rm(temporary, { recursive: true, force: true });
      }
    },
    120_000,
  );
}
