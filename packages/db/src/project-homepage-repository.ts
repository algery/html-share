import type { ProjectManagementReader } from "@html-share/core";
import type { PrismaClient } from "./generated/prisma/client.js";

export function createHomepageWriter(
  prisma: PrismaClient,
): NonNullable<ProjectManagementReader["setOwnedHomepage"]> {
  return (input) =>
    prisma.$transaction(async (tx) => {
      // Same project lock as publication and deletion. Validate files after locking.
      const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "demo_projects"
      WHERE "project_key" = ${input.projectKey} AND "owner_user_id" = ${input.ownerUserId}::uuid
        AND "status" = 'ACTIVE'
      FOR UPDATE
    `;
      const locked = rows[0];
      if (locked === undefined) return "not_found";
      const project = await tx.demoProject.findFirst({
        where: { id: locked.id, currentRevision: { is: { status: "ACTIVE" } } },
        select: { currentRevision: { select: { files: { select: { relativePath: true } } } } },
      });
      if (!project?.currentRevision) return "not_found";
      if (
        input.relativePath !== null &&
        (!/\.html?$/i.test(input.relativePath) ||
          !project.currentRevision.files.some((file) => file.relativePath === input.relativePath))
      )
        return "invalid_file";
      await tx.demoProject.update({
        where: { id: locked.id },
        data: { homepagePath: input.relativePath },
      });
      return "updated";
    });
}
