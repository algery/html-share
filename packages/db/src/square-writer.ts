import { SquareError, type SquareRepository } from "@html-share/core";
import type { PrismaClient } from "./generated/prisma/client.js";
import { squareSettings } from "./square-mapping.js";

export function createSquareWriter(
  prisma: PrismaClient,
): Pick<SquareRepository, "saveOwnedSettings" | "recordFailure"> {
  return {
    saveOwnedSettings(input) {
      return prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<
          { id: string }[]
        >`SELECT "id" FROM "demo_projects" WHERE "project_key" = ${input.projectKey} FOR UPDATE`;
        if (!locked[0]) throw new SquareError("SQUARE_NOT_FOUND", 404);
        const project = await tx.demoProject.findFirst({
          where: {
            id: locked[0].id,
            tenantId: input.tenantId,
            ownerUserId: input.ownerUserId,
            status: "ACTIVE",
            currentRevision: { is: { status: "ACTIVE", tenantId: input.tenantId } },
          },
          select: {
            id: true,
            squareSettings: true,
            squareAudience: { where: { tenantId: input.tenantId } },
          },
        });
        if (!project) throw new SquareError("SQUARE_NOT_FOUND", 404);
        const current = squareSettings(project.squareSettings, project.squareAudience);
        if (current.settingsVersion !== input.expectedVersion)
          throw new SquareError("SQUARE_VERSION_CONFLICT", 409);
        if (
          await tx.uploadTask.findFirst({
            where: { projectId: project.id, status: { in: ["PREPARED", "PROCESSING"] } },
            select: { id: true },
          })
        )
          throw new SquareError("SQUARE_UPLOAD_CONFLICT", 409);
        const next = input.settings.enabled ? input.settings : { ...current, enabled: false };
        const settingsVersion = current.settingsVersion + 1;
        const data = {
          enabled: next.enabled,
          settingsVersion,
          audienceType: next.audienceType,
          selectedDepartments: next.selectedDepartments.map((item) => ({ ...item })),
          selectedUsers: next.selectedUsers.map((item) => ({ ...item })),
          updatedAt: input.now,
          publishedAt: next.enabled ? input.now : (project.squareSettings?.publishedAt ?? null),
        };
        await tx.projectSquareSettings.upsert({
          where: { projectId: project.id },
          update: next.enabled ? data : { enabled: false, settingsVersion, updatedAt: input.now },
          create: { ...data, projectId: project.id, tenantId: input.tenantId },
        });
        if (next.enabled) {
          await tx.projectSquareAudience.deleteMany({ where: { projectId: project.id } });
          const targets = [
            ...next.departmentIds.map((subjectId) => ({ type: "department", subjectId })),
            ...next.userIds.map((subjectId) => ({ type: "user", subjectId })),
          ];
          if (targets.length)
            await tx.projectSquareAudience.createMany({
              data: targets.map((target) => ({
                ...target,
                projectId: project.id,
                tenantId: input.tenantId,
              })),
            });
        }
        await tx.squareAuditLog.create({
          data: {
            actorUserId: input.ownerUserId,
            tenantId: input.tenantId,
            projectId: project.id,
            action: !next.enabled ? "disable" : current.enabled ? "update" : "publish",
            result: "success",
            settingsVersion,
            requestIp: input.requestIp,
            traceId: input.traceId,
            createdAt: input.now,
          },
        });
        return { ...next, settingsVersion };
      });
    },
    async recordFailure(input) {
      const project = await prisma.demoProject.findFirst({
        where: {
          projectKey: input.projectKey,
          tenantId: input.tenantId,
          ownerUserId: input.ownerUserId,
        },
        select: { id: true },
      });
      await prisma.squareAuditLog.create({
        data: {
          actorUserId: input.ownerUserId,
          tenantId: input.tenantId,
          projectId: project?.id ?? null,
          action: input.action,
          result: input.result,
          settingsVersion: input.settingsVersion,
          requestIp: input.requestIp,
          traceId: input.traceId,
          createdAt: input.now,
        },
      });
    },
  };
}
