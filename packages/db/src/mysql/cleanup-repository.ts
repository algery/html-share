import type { ClaimedCleanupJob, CleanupBacklog } from "../cleanup-repository.js";
import { UPLOAD_CLEANUP_GRACE_MS } from "../upload-repository-maintenance.js";
import { enqueueCleanupJob, readObjectKeys } from "./cleanup-enqueue.js";
import { completeCleanupTarget } from "./cleanup-target.js";
import { mysqlTransaction } from "./transaction.js";
import type { MysqlClient } from "./types.js";

const CLEANUP_LEASE_MS = 10 * 60 * 1000;

export function createMysqlCleanupRepository(prisma: MysqlClient) {
  return {
    async claimNextCleanupJob(
      now: Date,
    ): Promise<(ClaimedCleanupJob & { attemptCount: number }) | null> {
      return mysqlTransaction(prisma, async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM cleanup_jobs
          WHERE (status IN ('PENDING', 'RETRY') AND run_after <= ${now})
            OR (status = 'RUNNING' AND updated_at <= ${new Date(now.getTime() - CLEANUP_LEASE_MS)})
          ORDER BY run_after ASC, created_at ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED
        `;
        const id = rows[0]?.id;
        if (id === undefined) return null;
        const job = await tx.cleanupJob.update({
          data: { status: "RUNNING", attemptCount: { increment: 1 }, updatedAt: now },
          where: { id },
        });
        return {
          attemptCount: job.attemptCount,
          id: job.id,
          kind: job.kind.toLowerCase() as ClaimedCleanupJob["kind"],
          objectKeys: readObjectKeys(job.objectKeys),
        };
      });
    },

    async completeCleanupJob(input: {
      claimAttempt: number;
      id: string;
      kind: ClaimedCleanupJob["kind"];
      now: Date;
    }) {
      await mysqlTransaction(prisma, async (tx) => {
        await tx.$queryRaw`SELECT id FROM cleanup_jobs WHERE id = ${input.id} FOR UPDATE`;
        const job = await tx.cleanupJob.findUnique({ where: { id: input.id } });
        if (job === null || job.status !== "RUNNING" || job.attemptCount !== input.claimAttempt)
          return;
        if (job.kind.toLowerCase() !== input.kind) throw new Error("CLEANUP_JOB_KIND_MISMATCH");
        await completeCleanupTarget(tx, job, input.now);
        await tx.cleanupJob.update({
          data: { completedAt: input.now, lastError: null, status: "COMPLETED" },
          where: { id: job.id },
        });
      });
    },

    async enqueueDueCleanupJobs(now: Date) {
      const uploadExpiryCutoff = new Date(now.getTime() - UPLOAD_CLEANUP_GRACE_MS);
      const [revisions, uploads, states] = await Promise.all([
        prisma.revision.findMany({
          include: { files: { select: { storageKey: true } } },
          where: { cleanupAfter: { lte: now }, status: { in: ["FAILED", "OBSOLETE"] } },
        }),
        prisma.uploadTask.findMany({
          select: {
            id: true,
            stagedObjectKeys: true,
            status: true,
            temporaryObjectKey: true,
            uploadFiles: { select: { storageKey: true } },
          },
          where: {
            OR: [
              { status: "COMPLETED" },
              { expiresAt: { lte: uploadExpiryCutoff }, status: { in: ["EXPIRED", "FAILED"] } },
            ],
            temporaryCleanedAt: null,
          },
        }),
        prisma.authState.findMany({ where: { expiresAt: { lte: now } }, select: { id: true } }),
      ]);
      const jobs = [
        ...revisions.map((revision) => ({
          kind: "REVISION" as const,
          objectKeys: revision.files.map((file) => file.storageKey),
          runAfter: now,
          targetId: revision.id,
        })),
        ...uploads.map((upload) => {
          const keys = [
            ...(upload.temporaryObjectKey === null ? [] : [upload.temporaryObjectKey]),
            ...readObjectKeys(upload.stagedObjectKeys),
          ];
          if (upload.status !== "COMPLETED")
            keys.push(...upload.uploadFiles.map((file) => file.storageKey));
          return {
            kind: "UPLOAD" as const,
            objectKeys: [...new Set(keys)],
            runAfter: now,
            targetId: upload.id,
          };
        }),
        ...states.map((state) => ({
          kind: "AUTH_STATE" as const,
          objectKeys: [],
          runAfter: now,
          targetId: state.id,
        })),
      ];
      // Validate the original target for every digest hit, including concurrent insertions.
      for (const job of jobs) await enqueueCleanupJob(prisma, job);
      return jobs.length;
    },

    async getCleanupBacklog(): Promise<CleanupBacklog> {
      const groups = await prisma.cleanupJob.groupBy({ by: ["status"], _count: { _all: true } });
      const count = (status: "PENDING" | "RETRY" | "RUNNING") =>
        groups.find((group) => group.status === status)?._count._all ?? 0;
      return { pending: count("PENDING"), retrying: count("RETRY"), running: count("RUNNING") };
    },

    async retryCleanupJob(input: {
      claimAttempt: number;
      errorCode: string;
      id: string;
      now: Date;
    }) {
      await mysqlTransaction(prisma, async (tx) => {
        await tx.$queryRaw`SELECT id FROM cleanup_jobs WHERE id = ${input.id} FOR UPDATE`;
        const job = await tx.cleanupJob.findUnique({ where: { id: input.id } });
        if (job === null || job.status !== "RUNNING" || job.attemptCount !== input.claimAttempt)
          return;
        const delayMs = Math.min(
          24 * 60 * 60 * 1000,
          60_000 * 2 ** Math.min(job.attemptCount - 1, 10),
        );
        await tx.cleanupJob.update({
          data: {
            lastError: input.errorCode.slice(0, 120),
            runAfter: new Date(input.now.getTime() + delayMs),
            status: "RETRY",
          },
          where: { id: job.id },
        });
      });
    },
  };
}
