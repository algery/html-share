import { Prisma } from "../generated/prisma-mysql/client.js";
import { assertSameText, textDigest } from "./path-identity.js";
import type { ClaimedObjectSweep } from "../orphan-sweep-repository.js";
import { mysqlTransaction } from "./transaction.js";
import type { MysqlClient } from "./types.js";

const SWEEP_ID = "projects";
const SWEEP_LEASE_MS = 10 * 60 * 1000;
const FULL_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const SWEEP_RETRY_MS = 60 * 1000;

export function createMysqlOrphanSweepRepository(prisma: MysqlClient) {
  return {
    async claimObjectSweep(now: Date): Promise<ClaimedObjectSweep | null> {
      return mysqlTransaction(prisma, async (tx) => {
        // The primary-key upsert serializes initial creation as well as later claims.
        await tx.$executeRaw`
          INSERT INTO object_sweep_states (id, run_after, created_at, updated_at)
          VALUES (${SWEEP_ID}, ${now}, ${now}, ${now})
          ON DUPLICATE KEY UPDATE id = id
        `;
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM object_sweep_states WHERE id = ${SWEEP_ID}
            AND run_after <= ${now}
            AND (claimed_at IS NULL OR claimed_at <= ${new Date(now.getTime() - SWEEP_LEASE_MS)})
          FOR UPDATE SKIP LOCKED
        `;
        if (rows[0] === undefined) return null;
        const claimed = await tx.objectSweepState.update({
          data: { claimedAt: now, updatedAt: now },
          where: { id: SWEEP_ID },
        });
        return {
          claimedAt: now,
          ...(claimed.continuationToken === null
            ? {}
            : { continuationToken: claimed.continuationToken }),
        };
      });
    },

    async referencedObjectKeys(keys: readonly string[]): Promise<Set<string>> {
      if (keys.length === 0) return new Set();
      const requested = new Map<string, string>();
      for (const key of keys) {
        const digest = textDigest(key).toString("hex");
        const previous = requested.get(digest);
        if (previous !== undefined) assertSameText(previous, key);
        requested.set(digest, key);
      }
      const digests = [...requested.keys()].map((digest) => Buffer.from(digest, "hex"));
      const [published, staged] = await Promise.all([
        prisma.$queryRaw<{ storageKey: string }[]>`
          SELECT storage_key AS storageKey FROM file_objects
          WHERE storage_key_digest IN (${Prisma.join(digests)})
        `,
        prisma.$queryRaw<{ storageKey: string }[]>`
          SELECT storage_key AS storageKey FROM upload_files
          WHERE storage_key_digest IN (${Prisma.join(digests)})
        `,
      ]);
      for (const object of [...published, ...staged]) {
        const expected = requested.get(textDigest(object.storageKey).toString("hex"));
        if (expected === undefined) throw new Error("OBJECT_SWEEP_IDENTITY_MISMATCH");
        assertSameText(object.storageKey, expected);
      }
      return new Set([...published, ...staged].map((object) => object.storageKey));
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
        data: { claimedAt: null, runAfter: new Date(input.now.getTime() + SWEEP_RETRY_MS) },
        where: { claimedAt: input.claimedAt, id: SWEEP_ID },
      });
    },
  };
}
