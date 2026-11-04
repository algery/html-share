import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createDatabaseClient, checkDatabaseReadiness } from "../packages/db/dist/index.js";

for (const provider of ["postgresql", "mysql"]) {
  const url = process.env[provider === "mysql" ? "PHASE24_MYSQL_URL" : "PHASE24_POSTGRES_URL"];
  const suite = url ? describe : describe.skip;
  suite(`Phase 24 ${provider} real database`, () => {
    const required = [
      provider === "mysql" ? "20261104000000_mysql_initial" : "20261104000000_database_identity",
    ];
    function connection() {
      if (!url || !/^html_share_phase24_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1))) {
        throw new Error("Phase 24 integration requires an isolated html_share_phase24_* database");
      }
      return createDatabaseClient({ DATABASE_PROVIDER: provider, DATABASE_URL: url });
    }

    it("reports unreachable endpoints and wrong credentials without raw driver details", async () => {
      for (const failure of ["credentials", "unreachable"]) {
        const target = new URL(url);
        if (failure === "credentials") target.password = "phase24-deliberately-invalid";
        else target.port = "1";
        if (provider === "mysql") {
          target.searchParams.set("connectTimeout", "100");
          target.searchParams.set("acquireTimeout", "300");
        }
        const db = createDatabaseClient({
          DATABASE_PROVIDER: provider,
          DATABASE_URL: target.toString(),
        });
        try {
          const result = checkDatabaseReadiness(db, required);
          await expect(result).rejects.toMatchObject({ reason: "connection" });
          await expect(result).rejects.not.toThrow("phase24-deliberately-invalid");
          await expect(result).rejects.not.toThrow(target.toString());
        } finally {
          await db.client.$disconnect();
        }
      }
    }, 15_000);

    it("checks migrations/identity and performs isolated transactional writes", async () => {
      const db = connection();
      try {
        const ready = await checkDatabaseReadiness(db, required);
        expect(ready.provider).toBe(provider);
        expect(ready.instanceId).toMatch(/^[\da-f-]{36}$/i);
        const stateDigest = randomUUID();
        await db.client.$transaction(async (tx) => {
          const state = await tx.authState.create({
            data: {
              stateDigest,
              audience: "APP",
              returnPath: "/中文/😀",
              expiresAt: new Date("2030-01-01T00:00:00.123Z"),
            },
          });
          const stored = await tx.authState.findUniqueOrThrow({ where: { id: state.id } });
          expect(stored.expiresAt.toISOString()).toBe("2030-01-01T00:00:00.123Z");
          expect(stored.returnPath).toBe("/中文/😀");
          expect(stored.consumedAt).toBeNull();
          await tx.authState.delete({ where: { id: state.id } });
        });
        expect(await db.client.authState.count({ where: { stateDigest } })).toBe(0);
        await expect(
          checkDatabaseReadiness(db, ["missing-required-migration"]),
        ).rejects.toMatchObject({ reason: "migration" });
      } finally {
        await db.client.$disconnect();
      }
    });

    it("rejects unfinished migrations and missing identity without leaking diagnostics", async () => {
      const db = connection();
      const id = randomUUID();
      let identity;
      try {
        await db.client
          .$executeRaw`INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count) VALUES (${id}, ${"0".repeat(64)}, ${"phase24_unfinished"}, ${new Date()}, 0)`;
        await expect(checkDatabaseReadiness(db, required)).rejects.toMatchObject({
          reason: "migration",
        });
        await db.client.$executeRaw`DELETE FROM _prisma_migrations WHERE id = ${id}`;
        identity = await db.client.databaseIdentity.findUniqueOrThrow({ where: { id: 1 } });
        await db.client.databaseIdentity.delete({ where: { id: 1 } });
        await expect(checkDatabaseReadiness(db, required)).rejects.toMatchObject({
          reason: "identity",
        });
      } finally {
        await db.client.$executeRaw`DELETE FROM _prisma_migrations WHERE id = ${id}`;
        if (identity)
          await db.client.databaseIdentity.upsert({
            where: { id: 1 },
            create: identity,
            update: {},
          });
        await db.client.$disconnect();
      }
    });

    it("enforces path uniqueness, Unicode, foreign keys, active-task and password constraints", async () => {
      const db = connection();
      const marker = randomUUID();
      let tenant;
      let user;
      let project;
      try {
        tenant = await db.client.tenant.create({
          data: { name: "Phase24 中文😀", dingtalkAppKeyRef: marker },
        });
        user = await db.client.user.create({
          data: {
            tenantId: tenant.id,
            dingtalkUserId: marker,
            displayName: "测试",
            lastLoginAt: new Date(),
          },
        });
        project = await db.client.demoProject.create({
          data: {
            tenantId: tenant.id,
            ownerUserId: user.id,
            projectKey: marker.slice(0, 5),
            displayName: "Phase24",
          },
        });
        const revision = await db.client.revision.create({
          data: { tenantId: tenant.id, projectId: project.id, revisionNumber: 1 },
        });
        const paths = [
          "中文😀/A.html",
          "中文😀/a.html",
          `${"x".repeat(1018)}A.html`,
          `${"x".repeat(1018)}B.html`,
        ];
        const records = [];
        for (const path of paths) {
          const file = {
            tenantId: tenant.id,
            projectId: project.id,
            revisionId: revision.id,
            relativePath: path,
            size: 2147483648n,
            contentHash: "a".repeat(64),
            mimeType: "text/html",
            storageKey: `${marker}/${path}`,
          };
          records.push(await db.client.fileObject.create({ data: file }));
          await expect(
            db.client.fileObject.create({
              data: { ...file, storageKey: `${randomUUID()}/${path}` },
            }),
          ).rejects.toBeDefined();
        }
        expect(records.map((row) => row.relativePath)).toEqual(paths);
        expect(records.every((row) => row.size === 2147483648n)).toBe(true);
        await expect(
          db.client.demoProject.update({
            where: { id: project.id },
            data: { accessMode: "password", passwordHash: null },
          }),
        ).rejects.toBeDefined();
        await expect(
          db.client.fileObject.create({
            data: {
              tenantId: tenant.id,
              projectId: project.id,
              revisionId: randomUUID(),
              relativePath: "missing.html",
              size: 1n,
              contentHash: "a".repeat(64),
              mimeType: "text/html",
              storageKey: randomUUID(),
            },
          }),
        ).rejects.toBeDefined();
        const taskData = {
          tenantId: tenant.id,
          projectId: project.id,
          ownerUserId: user.id,
          revisionId: revision.id,
          action: "CREATE",
          displayName: "Task",
          targetHtml: "A.html",
          declaredFileCount: 1,
          declaredTotalSize: 1n,
          manifestDigest: "a".repeat(64),
          clientRequestId: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
        };
        const task = await db.client.uploadTask.create({ data: taskData });
        await expect(
          db.client.uploadTask.create({ data: { ...taskData, clientRequestId: randomUUID() } }),
        ).rejects.toBeDefined();
        await db.client.uploadTask.update({
          where: { id: task.id },
          data: { status: "COMPLETED" },
        });
        const next = await db.client.uploadTask.create({
          data: { ...taskData, clientRequestId: randomUUID() },
        });
        expect(next.status).toBe("PREPARED");
        await expect(
          db.client.databaseIdentity.create({ data: { id: 2, instanceId: randomUUID() } }),
        ).rejects.toBeDefined();
      } finally {
        if (project) await db.client.demoProject.delete({ where: { id: project.id } });
        if (user) await db.client.user.delete({ where: { id: user.id } });
        if (tenant) await db.client.tenant.delete({ where: { id: tenant.id } });
        await db.client.$disconnect();
      }
    });
  });
}
