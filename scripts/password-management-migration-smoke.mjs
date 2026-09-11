import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createPasswordCrypto } from "../packages/core/dist/index.js";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const { Client } = require("pg");
const configured = new URL(
  process.env.PASSWORD_TEST_DATABASE_URL ??
    "postgresql://password_test:local-password-test-only@127.0.0.1:55432/html_share_password",
);
assert.equal(configured.hostname, "127.0.0.1");
assert.equal(configured.port, "55432");
assert.equal(configured.pathname, "/html_share_password");

const database = `html_share_password_management_migration_${process.pid}`;
configured.pathname = "/";
const baseUrl = configured.toString();
const admin = new Client({ connectionString: `${baseUrl}postgres` });
await admin.connect();
let client;
try {
  await admin.query(`CREATE DATABASE ${database}`);
  client = new Client({ connectionString: `${baseUrl}${database}` });
  await client.connect();
  const migrations = fileURLToPath(new URL("../packages/db/prisma/migrations", import.meta.url));
  const v15Migration = "20260910000000_project_password_management";
  for (const name of (await readdir(migrations)).sort()) {
    if (name < v15Migration) {
      await client.query(await readFile(`${migrations}/${name}/migration.sql`, "utf8"));
    }
  }

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  await client.query(
    "INSERT INTO tenants (id,name,dingtalk_app_key_ref,updated_at) VALUES ($1,$2,$3,now())",
    [tenantId, "V1.4 migration fixture", randomUUID()],
  );
  await client.query(
    "INSERT INTO users (id,tenant_id,dingtalk_user_id,display_name,last_login_at,updated_at) VALUES ($1,$2,$3,$4,now(),now())",
    [ownerId, tenantId, randomUUID(), "V1.4 owner"],
  );
  const organizationId = randomUUID();
  const passwordId = randomUUID();
  const legacyCrypto = createPasswordCrypto(Buffer.alloc(32, 13).toString("base64"));
  const legacyPassword = await legacyCrypto.generate();
  await client.query(
    `INSERT INTO demo_projects
      (id,tenant_id,owner_user_id,project_key,display_name,status,access_mode,password_hash,password_version,updated_at)
     VALUES
      ($1,$3,$4,'org14','Organization','ACTIVE','organization',NULL,0,now()),
      ($2,$3,$4,'pwd14','Password','ACTIVE','password',$5,1,now())`,
    [organizationId, passwordId, tenantId, ownerId, legacyPassword.hash],
  );
  const before = await client.query(
    "SELECT id,access_mode,password_hash,password_version FROM demo_projects ORDER BY project_key",
  );
  const migrationSql = await readFile(`${migrations}/${v15Migration}/migration.sql`, "utf8");
  await client.query(migrationSql);
  await client.query(migrationSql);
  const after = await client.query(
    "SELECT id,access_mode,password_hash,password_version,encrypted_password FROM demo_projects ORDER BY project_key",
  );
  assert.deepEqual(
    after.rows.map((row) => ({
      access_mode: row.access_mode,
      id: row.id,
      password_hash: row.password_hash,
      password_version: row.password_version,
    })),
    before.rows,
  );
  assert.deepEqual(
    after.rows.map((row) => row.encrypted_password),
    [null, null],
  );
  assert.equal(
    await legacyCrypto.verify(legacyPassword.password, after.rows[1]?.password_hash ?? ""),
    true,
  );
  await assert.rejects(
    client.query("UPDATE demo_projects SET encrypted_password='forbidden' WHERE id=$1", [
      organizationId,
    ]),
  );
  const taskColumn = await client.query(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_name='upload_tasks' AND column_name='pending_encrypted_password'`,
  );
  assert.equal(taskColumn.rows[0]?.is_nullable, "YES");
  console.log(
    JSON.stringify({
      historicalPasswordHashPreserved: true,
      historicalPasswordRemainsUnrecoverable: true,
      historicalPasswordStillVerifies: true,
      migrationRerunnable: true,
      organizationAccessPreserved: true,
      projectCiphertextConstraint: true,
    }),
  );
} finally {
  if (client) await client.end();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
}
