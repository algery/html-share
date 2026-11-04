import type { CleanupJob } from "../generated/prisma-mysql/client.js";
import type { MysqlTransactionClient } from "./types.js";

export async function completeCleanupTarget(
  tx: MysqlTransactionClient,
  job: CleanupJob,
  now: Date,
) {
  if (job.kind === "AUTH_STATE") {
    await tx.authState.deleteMany({ where: { id: job.targetId, expiresAt: { lte: now } } });
  } else if (job.kind === "PROJECT") {
    // Tombstones survive; subordinate metadata is removed only after object deletion.
    await tx.revision.deleteMany({ where: { projectId: job.targetId } });
  } else if (job.kind === "REVISION") {
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
    await tx.uploadTask.updateMany({
      data: { temporaryCleanedAt: now },
      where: { id: job.targetId, status: { in: ["COMPLETED", "EXPIRED", "FAILED"] } },
    });
  }
}
