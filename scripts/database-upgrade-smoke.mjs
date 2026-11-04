import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { readDatabaseEnv } from "../packages/config/src/database-environment.ts";
import { checkDatabaseReadiness, createDatabaseClient } from "../packages/db/dist/index.js";
import { runPrisma } from "./database-command.mjs";

let temporary;
let database;
try {
  const environment = readDatabaseEnv(process.env);
  const name = new URL(environment.DATABASE_URL).pathname.slice(1);
  if (
    environment.DATABASE_PROVIDER !== "postgresql" ||
    process.env.DATABASE_TEST_ISOLATED !== "1" ||
    !/^html_share_phase24_upgrade[a-z0-9_]*$/.test(name)
  ) {
    throw new Error(
      "Upgrade smoke requires an isolated html_share_phase24_upgrade* PostgreSQL database",
    );
  }
  const base = new URL("../.tmp/", import.meta.url);
  await mkdir(base, { recursive: true });
  temporary = await mkdtemp(fileURLToPath(new URL("phase24-upgrade-", base)));
  await cp(new URL("../packages/db/prisma/", import.meta.url), `${temporary}/schema`, {
    recursive: true,
  });
  await rm(`${temporary}/schema/database-metadata.prisma`);
  await rm(`${temporary}/schema/migrations/20261104000000_database_identity`, { recursive: true });
  await writeFile(
    `${temporary}/prisma.config.ts`,
    `import { defineConfig } from "prisma/config";\nexport default defineConfig({schema:"./schema",migrations:{path:"./schema/migrations"},datasource:{url:process.env.DATABASE_URL}});\n`,
  );
  runPrisma(["migrate", "deploy", "--config", `${temporary}/prisma.config.ts`], environment);
  database = createDatabaseClient(environment);
  const client = database.client;
  if (await client.tenant.count())
    throw new Error("Upgrade smoke requires an empty isolated database");
  const marker = randomUUID();
  const tenant = await client.tenant.create({
    data: { name: "Upgrade fixture", dingtalkAppKeyRef: marker },
  });
  const user = await client.user.create({
    data: {
      tenantId: tenant.id,
      dingtalkUserId: marker,
      displayName: "Upgrade owner",
      lastLoginAt: new Date(),
    },
  });
  const project = await client.demoProject.create({
    data: {
      tenantId: tenant.id,
      ownerUserId: user.id,
      projectKey: "upg24",
      displayName: "Upgrade fixture",
      accessMode: "password",
      passwordHash: "synthetic-upgrade-hash",
      encryptedPassword: "synthetic-upgrade-ciphertext",
      passwordVersion: 1,
      homepagePath: "首页.html",
    },
  });
  const revision = await client.revision.create({
    data: { tenantId: tenant.id, projectId: project.id, revisionNumber: 1, status: "ACTIVE" },
  });
  await client.demoProject.update({
    where: { id: project.id },
    data: { currentRevisionId: revision.id, status: "ACTIVE" },
  });
  await client.fileObject.create({
    data: {
      tenantId: tenant.id,
      projectId: project.id,
      revisionId: revision.id,
      relativePath: "首页.html",
      size: 12n,
      contentHash: "a".repeat(64),
      mimeType: "text/html",
      storageKey: `${marker}/首页.html`,
    },
  });
  await client.mcpToken.create({
    data: {
      userId: user.id,
      name: "Upgrade",
      tokenDigest: randomUUID(),
      tokenSuffix: "last",
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  await client.accessSession.create({
    data: {
      userId: user.id,
      audience: "APP",
      tokenDigest: randomUUID(),
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  await client.uploadTask.create({
    data: {
      tenantId: tenant.id,
      projectId: project.id,
      ownerUserId: user.id,
      revisionId: revision.id,
      action: "CREATE",
      status: "COMPLETED",
      displayName: "Upgrade",
      targetHtml: "首页.html",
      declaredFileCount: 1,
      declaredTotalSize: 12n,
      manifestDigest: "a".repeat(64),
      clientRequestId: randomUUID(),
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  const snapshot = async () => ({
    tenants: await client.tenant.findMany(),
    users: await client.user.findMany(),
    projects: await client.demoProject.findMany(),
    revisions: await client.revision.findMany(),
    files: await client.fileObject.findMany(),
    tokens: await client.mcpToken.findMany(),
    sessions: await client.accessSession.findMany(),
    tasks: await client.uploadTask.findMany(),
  });
  const before = await snapshot();
  const history =
    await client.$queryRaw`SELECT migration_name, checksum FROM _prisma_migrations ORDER BY migration_name`;
  runPrisma(["migrate", "deploy"], environment);
  runPrisma(["migrate", "deploy"], environment);
  assert.deepEqual(await snapshot(), before);
  const after =
    await client.$queryRaw`SELECT migration_name, checksum FROM _prisma_migrations ORDER BY migration_name`;
  assert.deepEqual(
    after.filter((row) => row.migration_name !== "20261104000000_database_identity"),
    history,
  );
  await checkDatabaseReadiness(database, ["20261104000000_database_identity"]);
  // All fixtures belong to this smoke invocation, never to the user's database.
  await client.demoProject.delete({ where: { id: project.id } });
  await client.user.delete({ where: { id: user.id } });
  await client.tenant.delete({ where: { id: tenant.id } });
  console.log(
    "PostgreSQL upgrade PASS: existing data and migration checksums preserved; repeat deploy passed",
  );
} catch {
  console.error(
    "PostgreSQL upgrade smoke failed; use a fresh isolated database and check migration state",
  );
  process.exitCode = 1;
} finally {
  if (database) await database.client.$disconnect();
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
