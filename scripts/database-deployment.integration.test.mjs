import { describe, expect, it } from "vitest";

import * as database from "../packages/db/dist/index.js";
import { buildWorkerApp } from "../apps/worker/src/app.ts";
import { registerDeploymentBarrierTests } from "./database-deployment-barrier-cases.mjs";
import { createDatabaseTestProxy } from "./database-deployment-proxy.mjs";
import { checkDatabaseDeployment } from "./database-deployment-preflight.mjs";

const configurations = [
  ["postgresql", process.env.PHASE26_GATE_POSTGRES_URL],
  ["mysql", process.env.PHASE26_GATE_MYSQL_URL],
];

for (const [provider, url] of configurations) {
  const suite = url ? describe : describe.skip;
  suite(`Phase26 ${provider} actual deployment readiness`, () => {
    function environment(suffix = "") {
      const target = new URL(url);
      if (
        target.protocol === (provider === "mysql" ? "mysql:" : "postgresql:") &&
        ["127.0.0.1", "localhost"].includes(target.hostname) &&
        target.pathname === "/html_share_phase26_gate"
      ) {
        target.pathname += suffix;
        return { DATABASE_PROVIDER: provider, DATABASE_URL: target.toString() };
      }
      throw new Error(
        "Readiness integration requires the dedicated local html_share_phase26_gate database",
      );
    }
    function targets(environments = [environment(), environment(), environment()]) {
      return environments.map((env, index) => ({
        role: ["server", "worker", "migration"][index],
        environment: env,
      }));
    }

    registerDeploymentBarrierTests(environment);

    it("accepts real SQL and different host addresses for the same logical instance", async () => {
      const alternate = new URL(environment().DATABASE_URL);
      alternate.hostname = "localhost";
      const result = await checkDatabaseDeployment(
        targets([
          environment(),
          { ...environment(), DATABASE_URL: alternate.toString() },
          environment(),
        ]),
        database,
      );
      expect(result.status).toBe("ok");
      expect(JSON.stringify(result)).not.toMatch(
        /phase25|instanceId|schemaVersion|mysql|postgresql/,
      );
    });

    it("rejects another logical database even on the same database server", async () => {
      await expect(
        checkDatabaseDeployment(
          targets([environment(), environment("_other"), environment()]),
          database,
        ),
      ).rejects.toThrow("mismatch (logical database)");
    });

    it("rejects a restored logical database even if its copied instance UUID matches", async () => {
      const primary = database.createDatabaseClient(environment());
      const restored = database.createDatabaseClient(environment("_other"));
      const original = await restored.client.databaseIdentity.findUniqueOrThrow({
        where: { id: 1 },
      });
      try {
        const source = await primary.client.databaseIdentity.findUniqueOrThrow({
          where: { id: 1 },
        });
        await restored.client.databaseIdentity.update({
          where: { id: 1 },
          data: { instanceId: source.instanceId },
        });
        await expect(
          checkDatabaseDeployment(
            targets([environment(), environment("_other"), environment()]),
            database,
          ),
        ).rejects.toThrow("mismatch (logical database)");
      } finally {
        await restored.client.databaseIdentity.update({
          where: { id: 1 },
          data: { instanceId: original.instanceId },
        });
        await primary.client.$disconnect();
        await restored.client.$disconnect();
      }
    });

    it("rejects an unmigrated target without initializing schema or identity", async () => {
      const connection = database.createDatabaseClient(environment("_old"));
      try {
        const before = await connection.client
          .$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_name = 'database_identity' AND table_schema = database()`.catch(
          async () =>
            connection.client
              .$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_name = 'database_identity' AND table_schema = current_schema()`,
        );
        expect(before).toEqual([]);
        await expect(
          checkDatabaseDeployment(
            targets([environment(), environment("_old"), environment()]),
            database,
          ),
        ).rejects.toThrow("worker database preflight failed (migration)");
        const after = await connection.client
          .$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_name = 'database_identity' AND table_schema = database()`.catch(
          async () =>
            connection.client
              .$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_name = 'database_identity' AND table_schema = current_schema()`,
        );
        expect(after).toEqual([]);
      } finally {
        await connection.client.$disconnect();
      }
    });

    it("rejects a changed checksum without modifying the history", async () => {
      const connection = database.createDatabaseClient(environment());
      const required = await database.readRequiredDatabaseMigrations(provider);
      const name = required.at(-1).name;
      const rows = await connection.client
        .$queryRaw`SELECT id, checksum FROM _prisma_migrations WHERE migration_name = ${name} AND finished_at IS NOT NULL AND rolled_back_at IS NULL`;
      const row = rows[0];
      try {
        await connection.client
          .$executeRaw`UPDATE _prisma_migrations SET checksum = ${"0".repeat(64)} WHERE id = ${row.id}`;
        await expect(checkDatabaseDeployment(targets(), database)).rejects.toThrow(
          "server database preflight failed (migration)",
        );
        const stored = await connection.client
          .$queryRaw`SELECT checksum FROM _prisma_migrations WHERE id = ${row.id}`;
        expect(stored[0].checksum).toBe("0".repeat(64));
      } finally {
        await connection.client
          .$executeRaw`UPDATE _prisma_migrations SET checksum = ${row.checksum} WHERE id = ${row.id}`;
        await connection.client.$disconnect();
      }
    });

    it("requires an existing identity and does not recreate it", async () => {
      const connection = database.createDatabaseClient(environment());
      const identity = await connection.client.databaseIdentity.findUniqueOrThrow({
        where: { id: 1 },
      });
      try {
        await connection.client.databaseIdentity.delete({ where: { id: 1 } });
        await expect(checkDatabaseDeployment(targets(), database)).rejects.toThrow(
          "server database preflight failed (identity)",
        );
        expect(await connection.client.databaseIdentity.count()).toBe(0);
      } finally {
        await connection.client.databaseIdentity.create({ data: identity });
        await connection.client.$disconnect();
      }
    });

    it.each(["credentials", "unreachable"])(
      "fails safely on %s without fallback",
      async (failure) => {
        const target = new URL(environment().DATABASE_URL);
        if (failure === "credentials") target.password = "phase26-private-wrong-password";
        else target.port = "1";
        if (provider === "mysql") {
          target.searchParams.set("connectTimeout", "100");
          target.searchParams.set("acquireTimeout", "300");
        }
        const result = checkDatabaseDeployment(
          targets([
            { ...environment(), DATABASE_URL: target.toString() },
            environment(),
            environment(),
          ]),
          database,
        );
        await expect(result).rejects.toThrow("server database preflight failed (connection)");
        await expect(result).rejects.not.toThrow("private");
        await expect(result).rejects.not.toThrow(target.toString());
      },
      15_000,
    );

    it("reports runtime schema loss as readiness 503 and recovers while live remains 200", async () => {
      const repositories = await database.openDatabaseRepositories(environment());
      const connection = database.createDatabaseClient(environment());
      const identity = await connection.client.databaseIdentity.findUniqueOrThrow({
        where: { id: 1 },
      });
      const app = buildWorkerApp({ logger: false, readiness: repositories.readiness });
      try {
        expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(200);
        await connection.client.databaseIdentity.delete({ where: { id: 1 } });
        const failed = await app.inject({ url: "/health/ready" });
        expect(failed.statusCode).toBe(503);
        expect(failed.json()).toEqual({ service: "worker", status: "not_ready" });
        expect((await app.inject({ url: "/health/live" })).statusCode).toBe(200);
        await connection.client.databaseIdentity.create({ data: identity });
        expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(200);
      } finally {
        await connection.client.databaseIdentity.upsert({
          where: { id: 1 },
          create: identity,
          update: identity,
        });
        await app.close();
        await repositories.close();
        await connection.client.$disconnect();
      }
    });

    it("detects a real runtime transport outage and recovers without restarting the app", async () => {
      const proxy = await createDatabaseTestProxy(environment());
      let repositories;
      let app;
      try {
        repositories = await database.openDatabaseRepositories(proxy.environment);
        app = buildWorkerApp({ logger: false, readiness: repositories.readiness });
        expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(200);
        // Let the driver finish its asynchronous connection release before an idle transport outage.
        await new Promise((resolve) => setTimeout(resolve, 100));
        await proxy.pause();
        expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(503);
        expect((await app.inject({ url: "/health/live" })).statusCode).toBe(200);
        await proxy.resume();
        const deadline = Date.now() + 5000;
        let status;
        do {
          status = (await app.inject({ url: "/health/ready" })).statusCode;
          if (status !== 200) await new Promise((resolve) => setTimeout(resolve, 100));
        } while (status !== 200 && Date.now() < deadline);
        expect(status).toBe(200);
      } finally {
        await app?.close();
        await repositories?.close();
        await proxy.pause();
      }
    }, 15_000);
  });
}
