import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPrismaClient } from "./auth-repository.js";
import { createOrphanSweepRepository } from "./orphan-sweep-repository.js";
import { createPublicationRaceFixture } from "./upload-publication-race.test-helper.js";

const databaseUrl = process.env["PHASE9_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

describeDatabase("orphan object sweep repository", () => {
  const prisma = databaseUrl === undefined ? null : createPrismaClient(databaseUrl);
  const tenantIds: string[] = [];

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma?.objectSweepState.deleteMany({ where: { id: "projects" } });
  });

  afterEach(async () => {
    if (prisma === null) return;
    await prisma.objectSweepState.deleteMany({ where: { id: "projects" } });
    const tenantId = tenantIds.pop();
    if (tenantId !== undefined) {
      await prisma.demoProject.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }
  });

  it("uses one leased cursor and protects staged or published object keys", async () => {
    if (prisma === null) throw new Error("PHASE9_DATABASE_URL is required");
    const now = new Date();
    const fixture = await createPublicationRaceFixture(
      prisma,
      now,
      new Date(now.getTime() + 300_000),
    );
    tenantIds.push(fixture.tenantId);
    const repository = createOrphanSweepRepository(prisma);

    const first = await repository.claimObjectSweep(now);
    expect(first).toEqual({ claimedAt: now });
    await expect(repository.claimObjectSweep(now)).resolves.toBeNull();
    await expect(
      repository.referencedObjectKeys([fixture.newStorageKey, "projects/orphan/index.html"]),
    ).resolves.toEqual(new Set([fixture.newStorageKey]));

    if (first === null) throw new Error("expected first sweep claim");
    await repository.completeObjectSweep({
      claimedAt: first.claimedAt,
      nextContinuationToken: "cursor-2",
      now,
    });
    const second = await repository.claimObjectSweep(now);
    expect(second).toEqual({ claimedAt: now, continuationToken: "cursor-2" });
    if (second === null) throw new Error("expected second sweep claim");
    await repository.completeObjectSweep({ claimedAt: second.claimedAt, now });

    await expect(repository.claimObjectSweep(now)).resolves.toBeNull();
    await expect(prisma.objectSweepState.count()).resolves.toBe(1);
  });
});
