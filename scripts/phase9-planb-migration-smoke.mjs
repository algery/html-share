import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const composeProject = process.env.HTML_SHARE_COMPOSE_PROJECT;
if (composeProject === undefined) throw new Error("HTML_SHARE_COMPOSE_PROJECT is required");

const database = "html_share_planb_migration_smoke";
const priorMigrations = [
  "20260902000000_phase2_auth",
  "20260902010000_phase3_mcp_tokens",
  "20260902020000_phase4_uploads",
  "20260902030000_phase4_hardening",
  "20260902040000_phase4_temporary_cleanup",
  "20260903000000_phase8_deletion_cleanup",
  "20260903010000_phase8_admin_rate_limit_audit",
  "20260903030000_phase9_upload_trace",
];

try {
  await psql("postgres", `DROP DATABASE IF EXISTS ${database} WITH (FORCE);`);
  await psql("postgres", `CREATE DATABASE ${database};`);
  for (const migration of priorMigrations) {
    await psql(
      database,
      await readFile(`packages/db/prisma/migrations/${migration}/migration.sql`, "utf8"),
    );
  }
  await psql(database, seedSql());
  await psql(
    database,
    await readFile(
      "packages/db/prisma/migrations/20260906000000_direct_file_uploads/migration.sql",
      "utf8",
    ),
  );
  await psql(
    database,
    await readFile(
      "packages/db/prisma/migrations/20260906010000_orphan_object_sweep/migration.sql",
      "utf8",
    ),
  );
  const result = await psql(
    database,
    `SELECT
      p.status || ':' || p.current_revision_id || ':' || active.status || ':' || pending.status || ':' ||
      task.status || ':' || task.failure_code || ':' || quota.status || ':' ||
      (SELECT count(*) FROM information_schema.tables WHERE table_name = 'upload_files') || ':' ||
      (SELECT count(*) FROM information_schema.tables WHERE table_name = 'object_sweep_states') || ':' ||
      (pending.cleanup_after >= task.created_at + interval '24 hours')
    FROM demo_projects p
    JOIN revisions active ON active.id = '44444444-4444-4444-8444-444444444444'::uuid
    JOIN revisions pending ON pending.id = '55555555-5555-4555-8555-555555555555'::uuid
    JOIN upload_tasks task ON task.id = '66666666-6666-4666-8666-666666666666'::uuid
    JOIN quota_reservations quota ON quota.upload_task_id = task.id
    WHERE p.id = '33333333-3333-4333-8333-333333333333'::uuid;`,
  );
  const expected =
    "ACTIVE:44444444-4444-4444-8444-444444444444:ACTIVE:FAILED:FAILED:UPLOAD_PROTOCOL_UNSUPPORTED:RELEASED:1:1:true";
  if (result.trim() !== expected) throw new Error(`unexpected migration state: ${result.trim()}`);
  console.log(
    JSON.stringify({
      activeCurrentRevisionPreserved: true,
      legacyTransientTaskFailed: true,
      orphanSweepStateTableCreated: true,
      quotaReleased: true,
      failedMetadataRetentionPreserved: true,
      uploadFilesTableCreated: true,
    }),
  );
} finally {
  await psql("postgres", `DROP DATABASE IF EXISTS ${database} WITH (FORCE);`).catch(
    () => undefined,
  );
}

function seedSql() {
  return `
    INSERT INTO tenants (id, name, dingtalk_app_key_ref, updated_at)
    VALUES ('11111111-1111-4111-8111-111111111111', 'Migration tenant', 'migration-smoke', now());
    INSERT INTO users (id, tenant_id, dingtalk_user_id, display_name, last_login_at, updated_at)
    VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'owner', 'Owner', now(), now());
    INSERT INTO demo_projects (id, tenant_id, owner_user_id, project_key, display_name, status, updated_at)
    VALUES ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'abc12', 'Existing', 'ACTIVE', now());
    INSERT INTO revisions (id, tenant_id, project_id, revision_number, status, file_count, total_size, published_at, updated_at)
    VALUES ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', 1, 'ACTIVE', 1, 4, now(), now());
    UPDATE demo_projects SET current_revision_id = '44444444-4444-4444-8444-444444444444' WHERE id = '33333333-3333-4333-8333-333333333333';
    INSERT INTO revisions (id, tenant_id, project_id, revision_number, status, updated_at)
    VALUES ('55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', 2, 'PENDING', now());
    INSERT INTO upload_tasks (id, tenant_id, project_id, owner_user_id, revision_id, action, status, display_name, target_html, declared_file_count, declared_total_size, declared_archive_size, manifest_digest, client_request_id, temporary_object_key, expires_at, updated_at)
    VALUES ('66666666-6666-4666-8666-666666666666', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', '55555555-5555-4555-8555-555555555555', 'REPLACE', 'PROCESSING', 'Legacy upload', 'index.html', 1, 4, 100, repeat('a', 64), '88888888-8888-4888-8888-888888888888', 'temporary/legacy.zip', now() + interval '5 minutes', now());
    INSERT INTO quota_reservations (id, tenant_id, user_id, upload_task_id, project_delta, storage_bytes, status, expires_at, updated_at)
    VALUES ('77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '66666666-6666-4666-8666-666666666666', 0, 0, 'RESERVED', now() + interval '5 minutes', now());
  `;
}

function psql(databaseName, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "--project-name",
        composeProject,
        "--env-file",
        ".env.example",
        "exec",
        "-T",
        "postgres",
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "html_share",
        "-d",
        databaseName,
        "-Atq",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`migration smoke psql failed: ${stderr.trim()}`));
    });
    child.stdin.end(sql);
  });
}
