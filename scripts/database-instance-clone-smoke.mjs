import assert from "node:assert/strict";
import * as database from "../packages/db/dist/index.js";
import { checkDatabaseDeployment } from "./database-deployment-preflight.mjs";
import { isolatedUrl } from "./database-compatibility-support.mjs";

const models = [
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
const results = [];
try {
  for (const provider of ["postgresql", "mysql"]) {
    const suffix = provider === "mysql" ? "MYSQL" : "POSTGRES";
    const urls = [
      isolatedUrl(
        process.env[`PHASE26_GATE_${suffix}_URL`],
        provider,
        /^html_share_phase26_gate$/,
        provider === "mysql" ? "53319" : "55439",
      ),
      isolatedUrl(
        process.env[`PHASE26_CLONE_${suffix}_URL`],
        provider,
        /^html_share_phase26_gate$/,
        provider === "mysql" ? "53320" : "55440",
      ),
    ];
    const environments = urls.map((url) => ({ DATABASE_PROVIDER: provider, DATABASE_URL: url }));
    const connections = environments.map((environment) =>
      database.createDatabaseClient(environment),
    );
    let original;
    const snapshot = async () =>
      Promise.all(
        connections.map((connection) =>
          Promise.all(models.map((model) => connection.client[model].count())),
        ),
      );
    try {
      const required = await database.readRequiredDatabaseMigrations(provider);
      const [source, clone] = connections;
      const before = await snapshot();
      const sourceIdentity = await source.client.databaseIdentity.findUniqueOrThrow({
        where: { id: 1 },
      });
      original = await clone.client.databaseIdentity.findUniqueOrThrow({ where: { id: 1 } });
      // Model a logical backup restored on a separate server with the SAME name/UUID.
      await clone.client.databaseIdentity.update({
        where: { id: 1 },
        data: { instanceId: sourceIdentity.instanceId },
      });
      const identities = await Promise.all(
        connections.map((connection) => database.checkDatabaseReadiness(connection, required)),
      );
      assert.equal(identities[0].instanceId, identities[1].instanceId);
      assert.equal(identities[0].schemaVersion, identities[1].schemaVersion);
      assert.notEqual(identities[0].logicalTarget, identities[1].logicalTarget);
      assert.throws(() => database.assertSameDatabaseDeployment(identities));
      await assert.rejects(
        checkDatabaseDeployment(
          [
            { role: "migration", environment: environments[0] },
            { role: "server", environment: environments[0] },
            { role: "worker", environment: environments[1] },
          ],
          database,
        ),
      );
      assert.deepEqual(
        await snapshot(),
        before,
        "Mismatched preflight must not write business tables",
      );
      results.push({
        provider,
        sameDatabaseName: true,
        copiedStoredIdentity: true,
        actualInstancesDistinguished: true,
        workerMismatchRejected: true,
        businessTablesUnchanged: models.length * 2,
      });
    } finally {
      if (original)
        await connections[1].client.databaseIdentity.update({
          where: { id: 1 },
          data: { instanceId: original.instanceId },
        });
      await Promise.all(connections.map((connection) => connection.client.$disconnect()));
    }
  }
  console.log(JSON.stringify({ status: "database-instance-clone-ok", results }));
} catch {
  console.error(
    "Database instance clone check failed; require two migrated dedicated same-name databases on separate local test servers; raw diagnostics withheld",
  );
  process.exitCode = 1;
}
