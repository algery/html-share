import { type PrismaClient, UploadTaskStatus } from "./generated/prisma/client.js";
import { UPLOAD_CLEANUP_GRACE_MS } from "./upload-repository-maintenance.js";

const CLEANUP_LEASE_MS = 10 * 60 * 1000;

export interface ClaimedCleanupJob {
  attemptCount: number;
  id: string;
  kind: "auth_state" | "project" | "revision" | "upload";
  objectKeys: string[];
}

export interface CleanupBacklog {
  pending: number;
  retrying: number;
  running: number;
}

export function createCleanupRepository(prisma: PrismaClient) {
  return {
    async claimNextCleanupJob(now: Date): Promise<ClaimedCleanupJob | null> {
      const claimed = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          WITH next_job AS (
            SELECT "id"
            FROM "cleanup_jobs"
            WHERE (
              "status" IN ('PENDING', 'RETRY')
              AND "run_after" <= ${now}
            ) OR (
              "status" = 'RUNNING'
              AND "updated_at" <= ${new Date(now.getTime() - CLEANUP_LEASE_MS)}
            )
            ORDER BY "run_after" ASC, "created_at" ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE "cleanup_jobs"
          SET "status" = 'RUNNING',
              "attempt_count" = "attempt_count" + 1,
              "updated_at" = ${now}
          FROM next_job
          WHERE "cleanup_jobs"."id" = next_job."id"
          RETURNING "cleanup_jobs"."id"
        `;
        const id = rows[0]?.id;
        return id === undefined ? null : tx.cleanupJob.findUniqueOrThrow({ where: { id } });
      });
      if (claimed === null) return null;
      return {
        attemptCount: claimed.attemptCount,
        id: claimed.id,
        kind: claimed.kind.toLowerCase() as ClaimedCleanupJob["kind"],
        objectKeys: readObjectKeys(claimed.objectKeys),
      };
    },

    async completeCleanupJob(input: {
      id: string;
      kind: ClaimedCleanupJob["kind"];
      now: Date;
      claimAttempt: number;
    }) {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM cleanup_jobs WHERE id = ${input.id}::uuid FOR UPDATE`;
        const job = await tx.cleanupJob.findUnique({ where: { id: input.id } });
        if (job === null || job.status !== "RUNNING" || job.attemptCount !== input.claimAttempt)
          return;
        if (job.kind.toLowerCase() !== input.kind) throw new Error("Cleanup claim kind mismatch");
        if (input.kind === "auth_state") {
          await tx.authState.deleteMany({
            where: { id: job.targetId, expiresAt: { lte: input.now } },
          });
        } else if (input.kind === "project") {
          // Keep the project tombstone, but remove all subordinate metadata after storage succeeds.
          await tx.revision.deleteMany({ where: { projectId: job.targetId } });
        } else if (input.kind === "revision") {
          const revision = await tx.revision.findUnique({
            select: { projectId: true },
            where: { id: job.targetId },
          });
          await tx.revision.deleteMany({
            where: { id: job.targetId, status: { in: ["FAILED", "OBSOLETE"] } },
          });
          if (revision !== null) {
            await tx.demoProject.deleteMany({
              where: {
                currentRevisionId: null,
                id: revision.projectId,
                revisions: { none: {} },
                status: "PENDING",
                uploadTasks: { none: {} },
              },
            });
          }
        } else {
          const task = await tx.uploadTask.findUnique({ where: { id: job.targetId } });
          if (
            task?.status === "COMPLETED" ||
            task?.status === "EXPIRED" ||
            task?.status === "FAILED"
          ) {
            await tx.uploadTask.update({
              data: { temporaryCleanedAt: input.now },
              where: { id: task.id },
            });
          }
        }
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
          where: {
            cleanupAfter: { lte: now },
            status: { in: ["FAILED", "OBSOLETE"] },
          },
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
              {
                expiresAt: { lte: uploadExpiryCutoff },
                status: { in: ["EXPIRED", "FAILED"] },
              },
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
        ...uploads.map((upload) => ({
          kind: "UPLOAD" as const,
          objectKeys: uploadObjectKeys(upload),
          runAfter: now,
          targetId: upload.id,
        })),
        ...states.map((state) => ({
          kind: "AUTH_STATE" as const,
          objectKeys: [],
          runAfter: now,
          targetId: state.id,
        })),
      ];
      if (jobs.length > 0) await prisma.cleanupJob.createMany({ data: jobs, skipDuplicates: true });
      return jobs.length;
    },

    async getCleanupBacklog(): Promise<CleanupBacklog> {
      const groups = await prisma.cleanupJob.groupBy({
        by: ["status"],
        _count: { _all: true },
      });
      const count = (status: "PENDING" | "RETRY" | "RUNNING") =>
        groups.find((group) => group.status === status)?._count._all ?? 0;
      return { pending: count("PENDING"), retrying: count("RETRY"), running: count("RUNNING") };
    },

    async retryCleanupJob(input: {
      errorCode: string;
      id: string;
      now: Date;
      claimAttempt: number;
    }) {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM cleanup_jobs WHERE id = ${input.id}::uuid FOR UPDATE`;
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
          where: { id: input.id },
        });
      });
    },
  };
}

function uploadObjectKeys(upload: {
  status: UploadTaskStatus;
  temporaryObjectKey: string | null;
  stagedObjectKeys: unknown;
  uploadFiles: readonly { storageKey: string }[];
}) {
  const legacyKeys = [
    ...(upload.temporaryObjectKey === null ? [] : [upload.temporaryObjectKey]),
    ...readObjectKeys(upload.stagedObjectKeys),
  ];
  return [
    ...new Set(
      upload.status === UploadTaskStatus.COMPLETED
        ? legacyKeys
        : [...legacyKeys, ...upload.uploadFiles.map((file) => file.storageKey)],
    ),
  ];
}

function readObjectKeys(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
