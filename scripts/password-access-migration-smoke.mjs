import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createPrismaClient } from "../packages/db/dist/auth-repository.js";
import { createPasswordCleanupRepository } from "../packages/db/dist/password-cleanup-repository.js";
import { createProjectDeletionRepository } from "../packages/db/dist/project-deletion-repository.js";
import { runPasswordAccessCleanup } from "../apps/worker/dist/jobs/cleanup-password-access.js";
const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const pg = require("pg");
const configured = new URL(
  process.env.PASSWORD_TEST_DATABASE_URL ??
    "postgresql://password_test:local-password-test-only@127.0.0.1:55432/html_share_password",
);
assert.equal(configured.hostname, "127.0.0.1");
assert.equal(configured.port, "55432");
assert.equal(configured.pathname, "/html_share_password");
const database = `html_share_password_migration_${process.pid}`;
configured.pathname = "/";
const baseUrl = configured.toString();
const admin = new pg.Client({ connectionString: `${baseUrl}postgres` });
await admin.connect();
let client;
let prisma;
try {
  await admin.query(`CREATE DATABASE ${database}`);
  client = new pg.Client({ connectionString: `${baseUrl}${database}` });
  await client.connect();
  const migrations = fileURLToPath(new URL("../packages/db/prisma/migrations", import.meta.url));
  const latest = "20260909000000_password_access";
  for (const name of (await readdir(migrations)).sort()) {
    if (name < latest)
      await client.query(await readFile(`${migrations}/${name}/migration.sql`, "utf8"));
  }
  const tenantId = randomUUID(),
    ownerId = randomUUID(),
    projectId = randomUUID(),
    revisionId = randomUUID(),
    taskId = randomUUID();
  await client.query(
    "INSERT INTO tenants (id,name,dingtalk_app_key_ref,updated_at) VALUES ($1,$2,$2,now())",
    [tenantId, "phase10"],
  );
  await client.query(
    "INSERT INTO users (id,tenant_id,dingtalk_user_id,display_name,last_login_at,updated_at) VALUES ($1,$2,$3,$3,now(),now())",
    [ownerId, tenantId, "owner"],
  );
  for (const [id, key, status] of [
    [projectId, "abc12", "ACTIVE"],
    [randomUUID(), "abc13", "PENDING"],
    [randomUUID(), "abc14", "DELETED"],
  ]) {
    await client.query(
      "INSERT INTO demo_projects (id,tenant_id,owner_user_id,project_key,display_name,status,updated_at) VALUES ($1,$2,$3,$4,$4,$5,now())",
      [id, tenantId, ownerId, key, status],
    );
  }
  await client.query(
    "INSERT INTO revisions (id,tenant_id,project_id,revision_number,status,updated_at) VALUES ($1,$2,$3,1,'ACTIVE',now())",
    [revisionId, tenantId, projectId],
  );
  await client.query("UPDATE demo_projects SET current_revision_id=$1 WHERE id=$2", [
    revisionId,
    projectId,
  ]);
  await client.query(
    `INSERT INTO upload_tasks (id,tenant_id,project_id,owner_user_id,revision_id,action,status,display_name,target_html,declared_file_count,declared_total_size,manifest_digest,client_request_id,expires_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,'REPLACE','PROCESSING','legacy','index.html',1,4,$6,$7,now()+interval '1 hour',now())`,
    [taskId, tenantId, projectId, ownerId, revisionId, "a".repeat(64), randomUUID()],
  );
  const beforeProjects = (await client.query("SELECT * FROM demo_projects ORDER BY id")).rows;
  const beforeTasks = (await client.query("SELECT * FROM upload_tasks ORDER BY id")).rows;
  const sql = await readFile(`${migrations}/${latest}/migration.sql`, "utf8");
  await client.query(sql);
  await client.query(sql);
  const afterProjects = (await client.query("SELECT * FROM demo_projects ORDER BY id")).rows;
  const afterTasks = (await client.query("SELECT * FROM upload_tasks ORDER BY id")).rows;
  for (let i = 0; i < beforeProjects.length; i++) {
    for (const key of Object.keys(beforeProjects[i]))
      assert.deepEqual(afterProjects[i][key], beforeProjects[i][key]);
    assert.equal(afterProjects[i].access_mode, "organization");
    assert.equal(afterProjects[i].password_hash, null);
    assert.equal(afterProjects[i].password_version, 0);
  }
  for (const key of Object.keys(beforeTasks[0]))
    assert.deepEqual(afterTasks[0][key], beforeTasks[0][key]);
  assert.equal(afterTasks[0].requested_access_mode, null);
  assert.equal(afterTasks[0].regenerate_password, false);
  await assert.rejects(
    client.query("UPDATE demo_projects SET access_mode='password' WHERE id=$1", [projectId]),
  );
  await assert.rejects(
    client.query("UPDATE demo_projects SET access_mode='public' WHERE id=$1", [projectId]),
  );
  await client.query(
    "UPDATE demo_projects SET access_mode='password',password_hash='active-hash',password_version=1 WHERE id=$1",
    [projectId],
  );
  await client.query(sql);
  assert.equal(
    (await client.query("SELECT password_hash FROM demo_projects WHERE id=$1", [projectId])).rows[0]
      .password_hash,
    "active-hash",
  );
  prisma = createPrismaClient(`${baseUrl}${database}`);
  const now = new Date();
  const repository = createPasswordCleanupRepository(prisma);
  await prisma.uploadTask.update({ where: { id: taskId }, data: { status: "COMPLETED" } });
  const makeTask = (id, status, createdAt, expiry) =>
    prisma.uploadTask.create({
      data: {
        id,
        tenantId,
        ownerUserId: ownerId,
        projectId,
        revisionId,
        action: "REPLACE",
        status,
        displayName: "new",
        targetHtml: "index.html",
        declaredFileCount: 1,
        declaredTotalSize: 4n,
        manifestDigest: "b".repeat(64),
        clientRequestId: randomUUID(),
        expiresAt: new Date(now.getTime() + 3600000),
        createdAt,
        pendingAccessMode: "password",
        pendingPasswordVersion: 1,
        pendingPasswordHash: "pending-hash",
        encryptedPasswordResult: "test-ciphertext",
        passwordResultExpiresAt: expiry,
      },
    });
  const expired = randomUUID(),
    failed = randomUUID(),
    valid = randomUUID(),
    locked = randomUUID(),
    old = randomUUID();
  await makeTask(expired, "COMPLETED", now, now);
  await makeTask(failed, "FAILED", now, new Date(now.getTime() + 3600000));
  await makeTask(valid, "PROCESSING", now, new Date(now.getTime() + 3600000));
  await makeTask(locked, "COMPLETED", now, now);
  await makeTask(old, "COMPLETED", new Date(now.getTime() - 86400001), null);
  await prisma.passwordAccessGrant.createMany({
    data: Array.from({ length: 103 }, (_, i) => ({
      tenantId,
      projectId,
      passwordVersion: 1,
      grantHash: randomUUID(),
      expiresAt: new Date(now.getTime() + (i === 102 ? 3600000 : -1)),
    })),
  });
  const revoked = await prisma.passwordAccessGrant.create({
    data: {
      tenantId,
      projectId,
      passwordVersion: 1,
      grantHash: randomUUID(),
      expiresAt: new Date(now.getTime() + 3600000),
      revokedAt: now,
    },
  });
  await client.query("BEGIN");
  await client.query("SELECT id FROM upload_tasks WHERE id=$1 FOR UPDATE", [locked]);
  assert.deepEqual(await repository.cleanupExpired(now), { results: 3, grants: 100 });
  assert.equal(
    (await prisma.uploadTask.findUniqueOrThrow({ where: { id: locked } })).encryptedPasswordResult,
    "test-ciphertext",
  );
  await client.query("COMMIT");
  assert.deepEqual(await repository.cleanupExpired(now), { results: 1, grants: 3 });
  assert.equal(await prisma.passwordAccessGrant.findUnique({ where: { id: revoked.id } }), null);
  assert.equal(await prisma.passwordAccessGrant.count(), 1);
  for (const id of [expired, failed, old, locked]) {
    const row = await prisma.uploadTask.findUniqueOrThrow({ where: { id } });
    assert.equal(row.pendingPasswordHash, null);
    assert.equal(row.encryptedPasswordResult, null);
  }
  assert.equal(
    (await prisma.uploadTask.findUniqueOrThrow({ where: { id: valid } })).pendingPasswordHash,
    "pending-hash",
  );
  assert.equal(
    (await prisma.demoProject.findUniqueOrThrow({ where: { id: projectId } })).passwordHash,
    "active-hash",
  );
  assert.equal(await runPasswordAccessCleanup({ repository, now: () => now }), "idle");
  assert.equal(
    await runPasswordAccessCleanup({
      repository: { cleanupExpired: async () => ({ results: 1, grants: 0 }) },
      now: () => now,
    }),
    "completed",
  );
  await assert.rejects(
    runPasswordAccessCleanup({
      repository: {
        cleanupExpired: async () => {
          throw new Error("simulated");
        },
      },
    }),
  );
  assert.equal(
    await createProjectDeletionRepository(prisma).deleteAsOwner({
      now,
      ownerUserId: ownerId,
      projectKey: "abc12",
    }),
    "deleted",
  );
  const deleted = await prisma.demoProject.findUniqueOrThrow({ where: { id: projectId } });
  assert.equal(deleted.passwordHash, null);
  assert.equal(deleted.passwordVersion, 2);
  assert.equal(deleted.accessMode, "organization");
  assert.equal(await prisma.passwordAccessGrant.count(), 0);
  assert.equal(
    await prisma.uploadTask.count({
      where: {
        projectId,
        OR: [
          { pendingPasswordHash: { not: null } },
          { encryptedPasswordResult: { not: null } },
          { pendingPasswordVersion: { not: null } },
        ],
      },
    }),
    0,
  );
  assert.equal(
    await prisma.cleanupJob.count({ where: { targetId: projectId, kind: "PROJECT" } }),
    1,
  );
  console.log(
    JSON.stringify({
      migrationPreservesLegacy: true,
      migrationRerunnable: true,
      constraintsRejectInvalidModes: true,
      cleanupBatchLimit: 100,
      skipLocked: true,
      expiryAndFailureCleanup: true,
      activePasswordPreserved: true,
      deleteRevokesAllMaterials: true,
      workerOutcomes: true,
    }),
  );
} finally {
  if (prisma) await prisma.$disconnect();
  if (client) await client.end();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
}
