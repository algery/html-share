import type { ProjectManagementReader, ProjectReader } from "@html-share/core";

import { DemoProjectStatus, RevisionStatus, type PrismaClient } from "./generated/prisma/client.js";

import { createHomepageWriter } from "./project-homepage-repository.js";

export function createProjectReader(prisma: PrismaClient): ProjectReader & ProjectManagementReader {
  return {
    setOwnedHomepage: createHomepageWriter(prisma),
    async findOwnedActiveProject(input) {
      const project = await prisma.demoProject.findFirst({
        select: {
          squareSettings: { select: { enabled: true } },
          accessMode: true,
          createdAt: true,
          displayName: true,
          fileCount: true,
          homepagePath: true,
          projectKey: true,
          totalSize: true,
          updatedAt: true,
          currentRevision: {
            select: {
              files: {
                orderBy: { relativePath: "asc" },
                select: { relativePath: true, size: true },
              },
            },
          },
        },
        where: {
          ownerUserId: input.ownerUserId,
          projectKey: input.projectKey,
          status: DemoProjectStatus.ACTIVE,
          currentRevision: { is: { status: RevisionStatus.ACTIVE } },
        },
      });
      if (project?.currentRevision === null || project === null) return null;
      const { currentRevision, squareSettings, ...summary } = project;
      return {
        ...summary,
        squareEnabled: squareSettings?.enabled ?? false,
        accessMode: summary.accessMode === "password" ? "password" : "organization",
        totalSize: Number(summary.totalSize),
        files: currentRevision.files.map((file) => ({
          relativePath: file.relativePath,
          size: Number(file.size),
        })),
      };
    },

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
          squareSettings: { select: { enabled: true } },
          accessMode: true,
          createdAt: true,
          displayName: true,
          fileCount: true,
          homepagePath: true,
          projectKey: true,
          totalSize: true,
          updatedAt: true,
          currentRevision: { select: { status: true, files: { select: { relativePath: true } } } },
        },
        where: {
          ownerUserId: input.ownerUserId,
          status: DemoProjectStatus.ACTIVE,
        },
      });
      return {
        projects: projects.map(({ currentRevision, squareSettings, ...project }) => ({
          ...project,
          squareEnabled: squareSettings?.enabled ?? false,
          htmlPaths:
            currentRevision?.status === RevisionStatus.ACTIVE
              ? currentRevision.files
                  .map((file) => file.relativePath)
                  .filter((path) => /\.html?$/i.test(path))
              : [],
          accessMode: project.accessMode === "password" ? "password" : "organization",
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
