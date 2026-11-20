import { SQUARE_COVER_PREFIX, type DatabaseRepositories } from "@html-share/db";
import type { ObjectStore } from "@html-share/storage";

export function createSquareCoverSweep(
  repository: DatabaseRepositories["squareCovers"],
  storage: ObjectStore,
) {
  let cursor: string | undefined;
  return async (shutdown: AbortSignal) => {
    const page = await storage.listObjects({
      prefix: SQUARE_COVER_PREFIX,
      ...(cursor ? { continuationToken: cursor } : {}),
      maxKeys: 100,
      timeoutMs: 5_000,
      abortSignal: AbortSignal.any([shutdown, AbortSignal.timeout(5_000)]),
    });
    const keys = page.keys.filter((key) => key.startsWith(SQUARE_COVER_PREFIX));
    if (keys.length > 0) {
      const referenced = await repository.referencedImages(keys, new Date());
      const obsolete = keys.filter((key) => !referenced.has(key));
      if (obsolete.length > 0) await storage.deleteObjects(obsolete);
    }
    cursor = page.nextContinuationToken;
  };
}
