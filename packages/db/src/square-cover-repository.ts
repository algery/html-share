import type { DatabaseConnection } from "./database-client.js";

export const SQUARE_COVER_PREFIX = "square-covers/";
const UPLOAD_CLEANUP_GRACE_MS = 10 * 60_000;

export function createSquareCoverRepository(connection: DatabaseConnection) {
  return {
    async referencedImages(keys: string[], now: Date) {
      const tasks = {
        where: {
          coverStorageKey: { in: keys },
          OR: [
            { status: "PROCESSING" as const },
            { expiresAt: { gt: new Date(now.getTime() - UPLOAD_CLEANUP_GRACE_MS) } },
          ],
        },
        select: { coverStorageKey: true },
      };
      // Check staged references first. A publishing transaction may move a key
      // from the task to a live cover between these two reads.
      const staged =
        connection.provider === "mysql"
          ? await connection.client.uploadTask.findMany(tasks)
          : await connection.client.uploadTask.findMany(tasks);
      const covers = {
        where: {
          privateImageKey: { in: keys },
          status: "ready",
          project: { status: "ACTIVE" as const },
        },
        select: {
          privateImageKey: true,
          revisionId: true,
          project: { select: { currentRevisionId: true } },
        },
      };
      const published =
        connection.provider === "mysql"
          ? await connection.client.projectSquareCover.findMany(covers)
          : await connection.client.projectSquareCover.findMany(covers);
      return new Set([
        ...staged.flatMap(({ coverStorageKey }) => (coverStorageKey ? [coverStorageKey] : [])),
        ...published.flatMap(({ privateImageKey, revisionId, project }) =>
          privateImageKey && revisionId === project.currentRevisionId ? [privateImageKey] : [],
        ),
      ]);
    },
  };
}
