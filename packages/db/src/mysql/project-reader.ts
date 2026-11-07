import type { MysqlClient } from "./types.js";
import type { ProjectManagementReader, ProjectReader } from "@html-share/core";

import { DemoProjectStatus, RevisionStatus } from "../generated/prisma-mysql/client.js";

import { createMysqlHomepageWriter } from "./project-homepage-repository.js";
import { assertSameText, textDigest } from "./path-identity.js";

export function createMysqlProjectReader(
  prisma: MysqlClient,
): ProjectReader & ProjectManagementReader {
  return {
    setOwnedHomepage: createMysqlHomepageWriter(prisma),
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
      const rows = await prisma.$queryRaw<
        {
          contentHash: string;
          relativePath: string;
          size: bigint;
          storageKey: string;
        }[]
      >`SELECT f.content_hash AS contentHash, f.relative_path AS relativePath,
          f.size, f.storage_key AS storageKey
        FROM demo_projects p
        JOIN revisions r ON r.id = p.current_revision_id AND r.project_id = p.id
          AND r.tenant_id = p.tenant_id AND r.status = 'ACTIVE'
        JOIN file_objects f ON f.revision_id = r.id AND f.project_id = p.id
          AND f.tenant_id = p.tenant_id
        WHERE p.project_key = ${input.projectKey} AND p.tenant_id = ${input.tenantId}
          AND p.status = 'ACTIVE' AND f.relative_path_digest = ${textDigest(input.relativePath)}
        LIMIT 1`;
      const file = rows[0];
      if (file === undefined) return null;
      assertSameText(file.relativePath, input.relativePath);
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
