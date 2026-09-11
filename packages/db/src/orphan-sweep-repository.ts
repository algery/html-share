import type { PrismaClient } from "./generated/prisma/client.js";

const SWEEP_ID = "projects";
const SWEEP_LEASE_MS = 10 * 60 * 1000;
const FULL_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const SWEEP_RETRY_MS = 60 * 1000;

export interface ClaimedObjectSweep {
  claimedAt: Date;
  continuationToken?: string;
}

export function createOrphanSweepRepository(prisma: PrismaClient) {
  return {
    async claimObjectSweep(now: Date): Promise<ClaimedObjectSweep | null> {
      await prisma.objectSweepState.upsert({
        create: { id: SWEEP_ID, runAfter: now },
        update: {},
        where: { id: SWEEP_ID },
      });
      const rows = await prisma.$queryRaw<{ claimedAt: Date; continuationToken: string | null }[]>`
        UPDATE "object_sweep_states"
        SET "claimed_at" = ${now}, "updated_at" = ${now}
        WHERE "id" = ${SWEEP_ID}
          AND "run_after" <= ${now}
          AND (
            "claimed_at" IS NULL
            OR "claimed_at" <= ${new Date(now.getTime() - SWEEP_LEASE_MS)}
          )
        RETURNING
          "claimed_at" AS "claimedAt",
          "continuation_token" AS "continuationToken"
      `;
      const claimed = rows[0];
      if (claimed === undefined) return null;
      return {
        claimedAt: claimed.claimedAt,
        ...(claimed.continuationToken === null
          ? {}
          : { continuationToken: claimed.continuationToken }),
      };
    },

    async referencedObjectKeys(keys: readonly string[]): Promise<Set<string>> {
      if (keys.length === 0) return new Set();
      const [published, staged] = await Promise.all([
        prisma.fileObject.findMany({
          select: { storageKey: true },
          where: { storageKey: { in: [...keys] } },
        }),
        prisma.uploadFile.findMany({
          select: { storageKey: true },
          where: { storageKey: { in: [...keys] } },
        }),
      ]);
      return new Set([
        ...published.map((object) => object.storageKey),
        ...staged.map((object) => object.storageKey),
      ]);
    },

    async completeObjectSweep(input: {
      claimedAt: Date;
      nextContinuationToken?: string;
      now: Date;
    }) {
      await prisma.objectSweepState.updateMany({
        data: {
          claimedAt: null,
          continuationToken: input.nextContinuationToken ?? null,
          runAfter:
            input.nextContinuationToken === undefined
              ? new Date(input.now.getTime() + FULL_SWEEP_INTERVAL_MS)
              : input.now,
        },
        where: { claimedAt: input.claimedAt, id: SWEEP_ID },
      });
    },

    async retryObjectSweep(input: { claimedAt: Date; now: Date }) {
      await prisma.objectSweepState.updateMany({
        data: {
          claimedAt: null,
          runAfter: new Date(input.now.getTime() + SWEEP_RETRY_MS),
        },
        where: { claimedAt: input.claimedAt, id: SWEEP_ID },
      });
    },
  };
}
