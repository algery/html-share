import type { ProjectManagementReader, ProjectReader } from "@html-share/core";

import { DemoProjectStatus, RevisionStatus, type PrismaClient } from "./generated/prisma/client.js";

export function createProjectReader(prisma: PrismaClient): ProjectReader & ProjectManagementReader {
  return {
    async findCurrentFile(input) {
      const project = await prisma.demoProject.findFirst({
        include: {
          currentRevision: {
            include: {
              files: {
                select: {
                  contentHash: true,
                  relativePath: true,
                  size: true,
                  storageKey: true,
                },
                where: { relativePath: input.relativePath },
              },
            },
          },
        },
        where: {
          currentRevision: { is: { status: RevisionStatus.ACTIVE } },
          projectKey: input.projectKey,
          status: DemoProjectStatus.ACTIVE,
          tenantId: input.tenantId,
        },
      });
      const file = project?.currentRevision?.files[0];
      if (file === undefined) return null;
      return {
        contentHash: file.contentHash,
        relativePath: file.relativePath,
        size: Number(file.size),
        storageKey: file.storageKey,
      };
    },

    async listOwnedActiveProjects(input) {
      const projects = await prisma.demoProject.findMany({
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        select: {
          createdAt: true,
          displayName: true,
          fileCount: true,
          projectKey: true,
          totalSize: true,
          updatedAt: true,
        },
        where: {
          ownerUserId: input.ownerUserId,
          status: DemoProjectStatus.ACTIVE,
        },
      });
      return {
        projects: projects.map((project) => ({
          ...project,
          totalSize: Number(project.totalSize),
        })),
        quota: {
          projectCount: projects.length,
          storageBytes: projects.reduce((total, project) => total + Number(project.totalSize), 0),
        },
      };
    },
  };
}
