import type {
  AdminProjectSummary,
  ProjectDeletionOutcome,
  ProjectDeletionRepository,
} from "@html-share/core";

import {
  AuditAction,
  DemoProjectStatus,
  RevisionStatus,
  UploadTaskStatus,
} from "../generated/prisma-mysql/client.js";
import { UPLOAD_CLEANUP_GRACE_MS } from "../upload-repository-maintenance.js";
import type { MysqlClient } from "./types.js";
import { mysqlTransaction } from "./transaction.js";
import { enqueueCleanupJob } from "./cleanup-enqueue.js";

export function createMysqlProjectDeletionRepository(
  prisma: MysqlClient,
): ProjectDeletionRepository {
  return {
    deleteAsOwner(input) {
      return removeProject(prisma, { ...input, actor: undefined, mode: "owner" });
    },

    deleteAsAdministrator(input) {
      return removeProject(prisma, { ...input, actor: input, mode: "administrator" });
    },

    async findForAdministrator(input) {
      const project = await prisma.demoProject.findUnique({
        include: { owner: { select: { displayName: true } } },
        where: { projectKey: input.projectKey },
      });
      if (project === null) return null;
      return {
        createdAt: project.createdAt,
        displayName: project.displayName,
        ownerDisplayName: project.owner.displayName,
        ownerUserId: project.ownerUserId,
        projectKey: project.projectKey,
        status: toProjectStatus(project.status),
        totalSize: Number(project.totalSize),
        updatedAt: project.updatedAt,
      };
    },

    async recordAdministratorRateLimit(input) {
      await prisma.auditLog.create({
        data: {
          action: AuditAction.ADMIN_RATE_LIMITED,
          actorUserId: input.actorUserId,
          requestIp: input.requestIp,
          traceId: input.traceId,
        },
      });
    },
  };
}

async function removeProject(
  prisma: MysqlClient,
  input:
    | {
        actor: undefined;
        mode: "owner";
        now: Date;
        ownerUserId: string;
        projectKey: string;
      }
    | {
        actor: { actorUserId: string; reason: string; requestIp: string; traceId: string };
        mode: "administrator";
        now: Date;
        projectKey: string;
      },
): Promise<ProjectDeletionOutcome> {
  return mysqlTransaction(prisma, async (tx) => {
    // Deletion and publication both serialize on this row. Lock before taking the
    // object snapshot so a publisher cannot commit new keys between the snapshot
    // and deletion's cleanup-job enqueue.
    const rows = await tx.$queryRaw<LockedProject[]>`
      SELECT id, owner_user_id AS ownerUserId, status
      FROM demo_projects
      WHERE project_key = ${input.projectKey}
      FOR UPDATE
    `;
    const project = rows[0];
    if (project === undefined) return "not_found";
    if (input.mode === "owner" && project.ownerUserId !== input.ownerUserId) return "forbidden";
    if (project.status === DemoProjectStatus.DELETED) return "already_deleted";

    const [files, tasks] = await Promise.all([
      tx.fileObject.findMany({ where: { projectId: project.id }, select: { storageKey: true } }),
      tx.uploadTask.findMany({
        where: { projectId: project.id },
        select: {
          id: true,
          expiresAt: true,
          stagedObjectKeys: true,
          temporaryObjectKey: true,
          uploadFiles: { select: { storageKey: true } },
        },
      }),
    ]);
    const cleanupRunAfter = tasks.reduce(
      (latest, task) =>
        new Date(Math.max(latest.getTime(), task.expiresAt.getTime() + UPLOAD_CLEANUP_GRACE_MS)),
      input.now,
    );
    const marked = await tx.demoProject.updateMany({
      data: {
        accessMode: "organization",
        encryptedPassword: null,
        passwordHash: null,
        passwordVersion: { increment: 1 },
        currentRevisionId: null,
        deletedAt: input.now,
        fileCount: 0,
        status: DemoProjectStatus.DELETED,
        totalSize: 0n,
      },
      where: { id: project.id, status: { not: DemoProjectStatus.DELETED } },
    });
    if (marked.count !== 1) return "already_deleted";

    await tx.uploadTask.updateMany({
      data: { failedAt: input.now, status: UploadTaskStatus.EXPIRED },
      where: {
        projectId: project.id,
        status: { in: [UploadTaskStatus.PREPARED, UploadTaskStatus.PROCESSING] },
      },
    });
    await tx.uploadTask.updateMany({
      data: {
        encryptedPasswordResult: null,
        pendingEncryptedPassword: null,
        passwordResultExpiresAt: null,
        // Keep historical mode so the completed task reports an unavailable password.
        pendingPasswordHash: null,
        pendingPasswordVersion: null,
      },
      where: { projectId: project.id },
    });
    await tx.passwordAccessGrant.deleteMany({ where: { projectId: project.id } });
    await tx.revision.updateMany({
      data: {
        cleanupAfter: cleanupRunAfter,
        failedAt: input.now,
        status: RevisionStatus.FAILED,
      },
      where: { projectId: project.id, status: { not: RevisionStatus.FAILED } },
    });
    await tx.quotaReservation.updateMany({
      data: { releasedAt: input.now, status: "RELEASED" },
      where: { uploadTask: { projectId: project.id }, status: "RESERVED" },
    });
    await enqueueCleanupJob(tx, {
      kind: "PROJECT",
      objectKeys: deduplicateObjectKeys(files, tasks),
      runAfter: cleanupRunAfter,
      targetId: project.id,
    });
    if (input.mode === "administrator") {
      await tx.auditLog.create({
        data: {
          action: AuditAction.PROJECT_DELETE,
          actorUserId: input.actor.actorUserId,
          ownerUserId: project.ownerUserId,
          projectId: project.id,
          reason: input.actor.reason,
          requestIp: input.actor.requestIp,
          traceId: input.actor.traceId,
        },
      });
    }
    return "deleted";
  });
}

interface LockedProject {
  id: string;
  ownerUserId: string;
  status: DemoProjectStatus;
}

function deduplicateObjectKeys(
  files: readonly { storageKey: string }[],
  tasks: readonly {
    expiresAt: Date;
    stagedObjectKeys: unknown;
    temporaryObjectKey: string | null;
    uploadFiles: readonly { storageKey: string }[];
  }[],
) {
  return [
    ...new Set([
      ...files.map((file) => file.storageKey),
      ...tasks.flatMap((task) => [
        ...(task.temporaryObjectKey === null ? [] : [task.temporaryObjectKey]),
        ...readObjectKeys(task.stagedObjectKeys),
        ...task.uploadFiles.map((file) => file.storageKey),
      ]),
    ]),
  ];
}

function readObjectKeys(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function toProjectStatus(status: DemoProjectStatus): AdminProjectSummary["status"] {
  if (status === DemoProjectStatus.ACTIVE) return "active";
  if (status === DemoProjectStatus.DELETED) return "deleted";
  return "pending";
}
