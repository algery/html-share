import type { MysqlTransactionClient } from "./types.js";
import { PROCESSING_LEASE_MS } from "./upload-repository-maintenance.js";

/** Sort without locks, then lock only an exact primary-key candidate. A locking
 * filesort can lock the entire pending set before LIMIT and starve peer claims. */
export async function claimableUploadId(tx: MysqlTransactionClient, now: Date) {
  const stale = new Date(now.getTime() - PROCESSING_LEASE_MS);
  let after: { id: string; createdAt: Date } | undefined;
  while (true) {
    const candidates = await tx.uploadTask.findMany({
      where: {
        status: "PROCESSING",
        expiresAt: { gt: now },
        AND: [
          { OR: [{ claimedAt: null }, { claimedAt: { lte: stale } }] },
          ...(after === undefined
            ? []
            : [
                {
                  OR: [
                    { createdAt: { gt: after.createdAt } },
                    { createdAt: after.createdAt, id: { gt: after.id } },
                  ],
                },
              ]),
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, createdAt: true },
      take: 32,
    });
    for (const candidate of candidates) {
      // Candidate snapshots may be stale after another claim/deletion. Recheck
      // every condition while acquiring just this row, never trust the scan.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM upload_tasks WHERE id = ${candidate.id}
          AND status = 'PROCESSING' AND expires_at > ${now}
          AND (claimed_at IS NULL OR claimed_at <= ${stale})
        FOR UPDATE SKIP LOCKED
      `;
      if (locked[0]) return locked[0].id;
    }
    if (candidates.length < 32) return undefined;
    // Keep literal boundaries: the last row may be deleted before the next page.
    after = candidates.at(-1);
  }
}
