import type { SquareRepository } from "@html-share/core";
import type { MysqlClient } from "./types.js";
import {
  squareSearchWhere,
  squareProjectSelect,
  squareProject,
  squareSettings,
  squareVisibleWhere,
} from "../square-mapping.js";
import { createMysqlSquareWriter } from "./square-writer.js";

export function createMysqlSquareRepository(prisma: MysqlClient): SquareRepository {
  return {
    ...createMysqlSquareWriter(prisma),
    async findOwnedSettings(input) {
      const project = await prisma.demoProject.findFirst({
        where: {
          tenantId: input.tenantId,
          ownerUserId: input.ownerUserId,
          projectKey: input.projectKey,
          status: "ACTIVE",
          currentRevision: { is: { status: "ACTIVE", tenantId: input.tenantId } },
        },
        select: {
          squareSettings: true,
          squareAudience: {
            where: { tenantId: input.tenantId },
            orderBy: [{ type: "asc" }, { subjectId: "asc" }],
          },
        },
      });
      return project ? squareSettings(project.squareSettings, project.squareAudience) : null;
    },
    async listVisible(input) {
      const where = {
        ...squareVisibleWhere(input),
        ...squareSearchWhere(input),
      };
      const total = await prisma.demoProject.count({ where });
      const page = Math.min(input.page, Math.max(1, Math.ceil(total / input.pageSize)));
      const projects = await prisma.demoProject.findMany({
        where,
        select: squareProjectSelect,
        orderBy: [{ currentRevision: { publishedAt: "desc" } }, { projectKey: "asc" }],
        skip: (page - 1) * input.pageSize,
        take: input.pageSize,
      });
      return { projects: projects.map(squareProject), total, page, pageSize: input.pageSize };
    },
    async findVisible(input) {
      const project = await prisma.demoProject.findFirst({
        where: { ...squareVisibleWhere(input), projectKey: input.projectKey },
        select: squareProjectSelect,
      });
      return project ? squareProject(project) : null;
    },
  };
}
