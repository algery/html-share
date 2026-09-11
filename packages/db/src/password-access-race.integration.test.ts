import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPasswordAccessService } from "@html-share/core";
import {
  createPasswordAccessFixture,
  passwordDatabaseUrl,
  waitForPasswordGrantLock,
} from "./password-access.test-helper.js";

const suite = passwordDatabaseUrl ? describe : describe.skip;
suite("password verification versus publication and deletion", () => {
  let fixture: Awaited<ReturnType<typeof createPasswordAccessFixture>>;
  beforeAll(async () => {
    fixture = await createPasswordAccessFixture();
  });
  afterAll(async () => {
    if (fixture) await fixture.cleanup();
  });

  it.each(["reset", "close", "delete", "remove-file", "disable-tenant"] as const)(
    "rechecks the exact target after waiting for a concurrent %s",
    async (operation) => {
      const { prisma, project, generated, repository, tenant } = fixture;
      const item = await project();
      let releaseMutation: () => void = () => undefined;
      let signalLocked: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        releaseMutation = resolve;
      });
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      let mutation: Promise<void> | undefined;
      let verification: ReturnType<typeof fixture.service.verifyPassword> | undefined;
      let verifyCalled = false;
      const service = createPasswordAccessService({
        repository,
        passwordCrypto: {
          async verify(password, hash) {
            const valid = await fixture.crypto.verify(password, hash);
            verifyCalled = true;
            // At this point scrypt has completed and no grant transaction is open.
            // Commit a real mutation only after grant creation waits on its project lock.
            mutation = prisma.$transaction(
              async (tx) => {
                await tx.$queryRaw`SELECT id FROM demo_projects WHERE id = ${item.id}::uuid FOR UPDATE`;
                signalLocked();
                await gate;
                if (operation === "reset")
                  await tx.demoProject.update({
                    where: { id: item.id },
                    data: { passwordVersion: 2 },
                  });
                if (operation === "close")
                  await tx.demoProject.update({
                    where: { id: item.id },
                    data: { accessMode: "organization", passwordHash: null },
                  });
                if (operation === "delete")
                  await tx.demoProject.update({
                    where: { id: item.id },
                    data: { status: "DELETED" },
                  });
                if (operation === "remove-file")
                  await tx.fileObject.delete({ where: { id: item.fileId } });
                if (operation === "disable-tenant")
                  await tx.tenant.update({
                    where: { id: tenant.id },
                    data: { status: "DISABLED" },
                  });
              },
              { timeout: 8000 },
            );
            await locked;
            return valid;
          },
        },
      });
      try {
        verification = service.verifyPassword({ ...item.path, password: generated.password });
        await locked;
        await waitForPasswordGrantLock(prisma);
        expect(verifyCalled).toBe(true);
        releaseMutation();
        await mutation;
        expect(await verification).toBeNull();
        expect(await prisma.passwordAccessGrant.count({ where: { projectId: item.id } })).toBe(0);
      } finally {
        releaseMutation();
        await Promise.allSettled([mutation, verification]);
        await prisma.tenant.update({ where: { id: tenant.id }, data: { status: "ACTIVE" } });
      }
    },
    15000,
  );

  it("rejects a stale verified hash even if an invalid writer forgets to increment its version", async () => {
    const { repository, prisma, project, generated, crypto } = fixture;
    const item = await project();
    const service = createPasswordAccessService({
      repository,
      passwordCrypto: {
        async verify(password, hash) {
          const valid = await crypto.verify(password, hash);
          await prisma.demoProject.update({
            where: { id: item.id },
            data: { passwordHash: (await crypto.generate()).hash },
          });
          return valid;
        },
      },
    });
    expect(await service.verifyPassword({ ...item.path, password: generated.password })).toBeNull();
  });

  it("holds the project SHARE lock until grant insertion, then lets reset invalidate it", async () => {
    const { prisma, service, project, generated } = fixture;
    const item = await project();
    let releaseInsert: () => void = () => undefined;
    let signalLocked: () => void = () => undefined;
    const insertGate = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    let issued: ReturnType<typeof service.verifyPassword> | undefined;
    let reset: Promise<unknown> | undefined;
    // Stop at the real INSERT to observe which locks the grant transaction retains.
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`LOCK TABLE password_access_grants IN ACCESS EXCLUSIVE MODE`;
        signalLocked();
        await insertGate;
      },
      { timeout: 8000 },
    );
    try {
      await locked;
      issued = service.verifyPassword({ ...item.path, password: generated.password });
      await waitForQueryLock("password_access_grants");
      reset = Promise.resolve(
        prisma.demoProject.update({ where: { id: item.id }, data: { passwordVersion: 2 } }),
      );
      await waitForQueryLock("UPDATE%demo_projects");
      releaseInsert();
      await blocker;
      const grant = await issued;
      await reset;
      if (!grant) throw new Error("Grant should precede the blocked reset");
      expect(await service.authorize({ ...item.path, token: grant.token })).toBeNull();
    } finally {
      releaseInsert();
      await Promise.allSettled([blocker, issued, reset]);
    }
  }, 15000);

  async function waitForQueryLock(fragment: string) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const rows = await fixture.prisma.$queryRaw<{ blocked: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND pid <> pg_backend_pid() AND state = 'active' AND wait_event_type = 'Lock'
          AND query LIKE ${`%${fragment}%`}) AS "blocked"`;
      if (rows[0]?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Expected password access transaction lock was not observed");
  }
});
