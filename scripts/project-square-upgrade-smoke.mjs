import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDatabaseClient, createDatabaseRepositories } from "../packages/db/dist/index.js";
import { runPrisma } from "./database-command.mjs";

const databaseName = "html_share_phase25_square_upgrade";
const migration = "20261107000000_project_square";
const legacyUserSelect = {
  id: true,
  tenantId: true,
  dingtalkUserId: true,
  displayName: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
};
const directory = new URL("../.tmp/", import.meta.url);
let stage = "validate isolation";

function environment(provider) {
  const value = process.env[provider === "mysql" ? "PHASE25_MYSQL_URL" : "PHASE25_POSTGRES_URL"];
  if (!value) throw new Error("Missing isolated matrix connection");
  const source = new URL(value);
  if (
    source.protocol !== `${provider}:` ||
    !["127.0.0.1", "localhost", "[::1]"].includes(source.hostname) ||
    !/^html_share_phase25_square(?:_[a-z0-9]+)*$/.test(source.pathname.slice(1)) ||
    !/^[a-zA-Z0-9_]+$/.test(source.username)
  )
    throw new Error("Not an isolated local square matrix");
  source.pathname = `/${databaseName}`;
  return { DATABASE_PROVIDER: provider, DATABASE_URL: source.toString() };
}
function docker(provider, command, parameters = []) {
  const container = provider === "mysql" ? "html-share-square-mysql" : "html-share-square-postgres";
  const result = spawnSync(
    "docker",
    ["exec", container, "sh", "-c", command, "square-upgrade", ...parameters],
    {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  // Never expose SQL/driver diagnostics or the temporary container's credentials.
  if (result.error || result.status !== 0) throw new Error("Isolated database operation failed");
}
function createDatabase(env) {
  const user = new URL(env.DATABASE_URL).username;
  if (env.DATABASE_PROVIDER === "mysql") {
    docker("mysql", 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --user=root --execute="$1"', [
      `CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`,
    ]);
  } else {
    docker("postgresql", 'createdb -U "$POSTGRES_USER" --owner="$2" "$1"', [databaseName, user]);
  }
}
function grantDatabase(env) {
  if (env.DATABASE_PROVIDER !== "mysql") return;
  const user = new URL(env.DATABASE_URL).username;
  docker("mysql", 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --user=root --execute="$1"', [
    `GRANT ALL PRIVILEGES ON \`${databaseName}\`.* TO '${user}'@'%'`,
  ]);
}
function dropDatabase(provider) {
  if (provider === "mysql") {
    docker(provider, 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --user=root --execute="$1"', [
      `DROP DATABASE \`${databaseName}\``,
    ]);
  } else {
    docker(provider, 'dropdb -U "$POSTGRES_USER" "$1"', [databaseName]);
  }
}
async function prepareLegacySchema(provider) {
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(fileURLToPath(new URL("square-upgrade-", directory)));
  try {
    const source = provider === "mysql" ? "prisma-mysql" : "prisma";
    await cp(new URL(`../packages/db/${source}/`, import.meta.url), `${temporary}/schema`, {
      recursive: true,
    });
    await rm(`${temporary}/schema/migrations/${migration}`, { recursive: true });
    await rm(`${temporary}/schema/square.prisma`);
    const publication = `${temporary}/schema/publication.prisma`;
    const original = await readFile(publication, "utf8");
    await writeFile(
      publication,
      original
        .split("\n")
        .filter(
          (line) =>
            !/^\s*(squareAudits|squareSettings|squareAudience|dingtalkUnionId)\s/.test(line),
        )
        .join("\n"),
    );
    await writeFile(
      `${temporary}/prisma.config.ts`,
      'import { defineConfig } from "prisma/config";\nexport default defineConfig({schema:"./schema",migrations:{path:"./schema/migrations"},datasource:{url:process.env.DATABASE_URL}});\n',
    );
    return temporary;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
async function seedLegacy(client) {
  const tenant = await client.tenant.create({
    data: { name: "Square upgrade synthetic", dingtalkAppKeyRef: randomUUID() },
  });
  // Explicit old-column projection lets the current generated client seed the genuinely old schema.
  const user = await client.user.create({
    select: legacyUserSelect,
    data: {
      tenantId: tenant.id,
      dingtalkUserId: "legacy-open-id",
      displayName: "Legacy owner",
      lastLoginAt: new Date(),
    },
  });
  const project = await client.demoProject.create({
    data: {
      tenantId: tenant.id,
      ownerUserId: user.id,
      projectKey: "sqg27",
      displayName: "Legacy square project",
      accessMode: "password",
      passwordHash: "synthetic-upgrade-hash",
      encryptedPassword: "synthetic-upgrade-ciphertext",
      passwordVersion: 2,
      homepagePath: "首页.html",
      fileCount: 1,
      totalSize: 3n,
    },
  });
  const revision = await client.revision.create({
    data: {
      tenantId: tenant.id,
      projectId: project.id,
      revisionNumber: 1,
      status: "ACTIVE",
      publishedAt: new Date(),
      fileCount: 1,
      totalSize: 3n,
    },
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
      size: 3n,
      contentHash: "a".repeat(64),
      mimeType: "text/html",
      storageKey: `synthetic-square-upgrade/${randomUUID()}/首页.html`,
    },
  });
  const token = await client.mcpToken.create({
    data: {
      userId: user.id,
      name: "Legacy token",
      tokenDigest: randomUUID(),
      tokenSuffix: "last",
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  const session = await client.accessSession.create({
    data: {
      userId: user.id,
      audience: "APP",
      tokenDigest: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  return { tenant, user, project, token, session };
}
async function snapshot(client) {
  return {
    tenants: await client.tenant.findMany(),
    users: await client.user.findMany({ select: legacyUserSelect }),
    projects: await client.demoProject.findMany(),
    revisions: await client.revision.findMany(),
    files: await client.fileObject.findMany(),
    tokens: await client.mcpToken.findMany(),
    sessions: await client.accessSession.findMany(),
  };
}
async function history(client) {
  return client.$queryRaw`SELECT migration_name, checksum, finished_at FROM _prisma_migrations ORDER BY migration_name`;
}
async function validateUpgrade(provider, env) {
  let created = false;
  let temporary;
  let connection;
  try {
    stage = `${provider} create fresh database`;
    createDatabase(env);
    created = true;
    grantDatabase(env);
    temporary = await prepareLegacySchema(provider);
    stage = `${provider} deploy legacy migrations`;
    runPrisma(["migrate", "deploy", "--config", `${temporary}/prisma.config.ts`], env);
    connection = createDatabaseClient(env);
    const client = connection.client;
    assert.equal(await client.tenant.count(), 0);
    const columns =
      provider === "mysql"
        ? await client.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'dingtalk_union_id'`
        : await client.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'dingtalk_union_id'`;
    assert.equal(columns.length, 0, "legacy schema must genuinely lack unionId");
    const existing = await seedLegacy(client);
    const before = await snapshot(client);
    const oldHistory = await history(client);
    stage = `${provider} deploy square migration`;
    runPrisma(["migrate", "deploy"], env);
    assert.deepEqual(await snapshot(client), before);
    assert.deepEqual(
      (await history(client)).filter((row) => row.migration_name !== migration),
      oldHistory,
    );
    assert.equal(
      (await client.user.findUniqueOrThrow({ where: { id: existing.user.id } })).dingtalkUnionId,
      null,
    );
    assert.equal(await client.projectSquareSettings.count(), 0);
    assert.equal(await client.projectSquareAudience.count(), 0);
    assert.equal(await client.squareAuditLog.count(), 0);
    const repositories = createDatabaseRepositories(connection);
    assert.deepEqual(
      await repositories.square.findOwnedSettings({
        tenantId: existing.tenant.id,
        ownerUserId: existing.user.id,
        projectKey: existing.project.projectKey,
      }),
      {
        enabled: false,
        audienceType: null,
        departmentIds: [],
        userIds: [],
        settingsVersion: 0,
        selectedDepartments: [],
        selectedUsers: [],
      },
    );
    assert.equal(
      (
        await repositories.square.listVisible({
          tenantId: existing.tenant.id,
          userId: existing.user.id,
          member: null,
          q: "",
          page: 1,
          pageSize: 10,
        })
      ).total,
      0,
    );
    const session = await repositories.auth.findAccessSession({
      tokenDigest: existing.session.tokenDigest,
      audience: "app",
      now: new Date(),
    });
    assert.equal(session.user.id, existing.user.id);
    const token = await repositories.mcpTokens.findActiveToken({
      tokenDigest: existing.token.tokenDigest,
      now: new Date(),
    });
    assert.equal(token.user.id, existing.user.id);
    const afterHistory = await history(client);
    stage = `${provider} repeat deployment`;
    runPrisma(["migrate", "deploy"], env);
    assert.deepEqual(await snapshot(client), before);
    assert.deepEqual(await history(client), afterHistory);
    console.log(
      `${provider} square upgrade PASS: old schema verified, original ownership/data preserved, unionId null, square off, repeated deploy unchanged`,
    );
  } finally {
    if (connection) await connection.client.$disconnect();
    if (temporary) await rm(temporary, { recursive: true, force: true });
    if (created) dropDatabase(provider);
  }
}
try {
  const environments = ["postgresql", "mysql"].map((provider) => [provider, environment(provider)]);
  for (const [provider, env] of environments) await validateUpgrade(provider, env);
} catch {
  console.error(
    `Square upgrade smoke failed at ${stage}; only its own isolated upgrade database is eligible for cleanup`,
  );
  process.exitCode = 1;
}
