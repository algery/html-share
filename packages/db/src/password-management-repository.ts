import type { DemoAccessMode, PasswordManagementRepository } from "@html-share/core";

import {
  AuditAction,
  DemoProjectStatus,
  UploadTaskStatus,
  type PrismaClient,
} from "./generated/prisma/client.js";

export function createPasswordManagementRepository(
  prisma: PrismaClient,
): PasswordManagementRepository {
  return {
    async findOwnedActive(input) {
      const project = await prisma.demoProject.findFirst({
        select: {
          accessMode: true,
          encryptedPassword: true,
          id: true,
          ownerUserId: true,
          passwordVersion: true,
          projectKey: true,
        },
        where: {
          ownerUserId: input.ownerUserId,
          projectKey: input.projectKey,
          status: DemoProjectStatus.ACTIVE,
        },
      });
      if (project === null) return null;
      return { ...project, accessMode: readAccessMode(project.accessMode) };
    },

    applyOwnedChange(input) {
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<LockedProject[]>`
          SELECT "id", "tenant_id" AS "tenantId", "owner_user_id" AS "ownerUserId",
                 "status", "access_mode" AS "accessMode",
                 "password_version" AS "passwordVersion"
          FROM "demo_projects"
          WHERE "project_key" = ${input.projectKey}
          FOR UPDATE
        `;
        const project = rows[0];
        if (
          project === undefined ||
          project.ownerUserId !== input.ownerUserId ||
          project.status !== DemoProjectStatus.ACTIVE
        ) {
          return "not_found";
        }
        if (
          project.accessMode !== input.expectedAccessMode ||
          project.passwordVersion !== input.expectedPasswordVersion
        ) {
          return "conflict";
        }
        const activeUpload = await tx.uploadTask.findFirst({
          select: { id: true },
          where: {
            projectId: project.id,
            status: { in: [UploadTaskStatus.PREPARED, UploadTaskStatus.PROCESSING] },
          },
        });
        if (activeUpload !== null) return "upload_conflict";

        const accessMode: DemoAccessMode = input.action === "disable" ? "organization" : "password";
        await tx.demoProject.update({
          data: {
            accessMode,
            encryptedPassword: input.encryptedPassword,
            passwordHash: input.passwordHash,
            passwordVersion: input.passwordVersion,
          },
          where: { id: project.id },
        });
        await tx.passwordAccessGrant.updateMany({
          data: { revokedAt: input.now },
          where: { projectId: project.id, revokedAt: null },
        });
        await tx.uploadTask.updateMany({
          data: {
            encryptedPasswordResult: null,
            pendingEncryptedPassword: null,
            passwordResultExpiresAt: null,
            pendingPasswordHash: null,
          },
          where: { projectId: project.id },
        });
        await tx.auditLog.create({
          data: {
            action: auditAction(input.action),
            actorUserId: input.ownerUserId,
            ownerUserId: input.ownerUserId,
            projectId: project.id,
            requestIp: input.requestIp,
            traceId: input.traceId,
          },
        });
        return "updated";
      });
    },
  };
}

interface LockedProject {
  accessMode: string;
  id: string;
  ownerUserId: string;
  passwordVersion: number;
  status: DemoProjectStatus;
  tenantId: string;
}

function readAccessMode(value: string): DemoAccessMode {
  return value === "password" ? "password" : "organization";
}

function auditAction(action: "disable" | "enable" | "regenerate") {
  if (action === "enable") return AuditAction.PASSWORD_ACCESS_ENABLE;
  if (action === "regenerate") return AuditAction.PASSWORD_ACCESS_REGENERATE;
  return AuditAction.PASSWORD_ACCESS_DISABLE;
}
