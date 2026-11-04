import type { ProjectManagementReader } from "@html-share/core";
import { mysqlTransaction } from "./transaction.js";
import type { MysqlClient } from "./types.js";

export function createMysqlHomepageWriter(
  prisma: MysqlClient,
): NonNullable<ProjectManagementReader["setOwnedHomepage"]> {
  return (input) =>
    mysqlTransaction(prisma, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM demo_projects
      WHERE project_key = ${input.projectKey} AND owner_user_id = ${input.ownerUserId}
        AND status = 'ACTIVE' FOR UPDATE`;
      const locked = rows[0];
      if (!locked) return "not_found";
      // Current revision and files must be read after the shared publication lock.
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
