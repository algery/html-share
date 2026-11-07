import { createHash } from "node:crypto";

import { SQUARE_COVER_PREFIX, type DatabaseRepositories } from "@html-share/db";
import type { ObjectStore } from "@html-share/storage";

import { isSquareRendererReady, renderSquareCover } from "./square-cover-render-client.js";

const SCAN_BATCH = 25;
const SWEEP_INTERVAL_MS = 60_000;
const JOB_TIMEOUT_MS = 30_000;

type Repository = DatabaseRepositories["squareCovers"];
type RenderClaim = NonNullable<Awaited<ReturnType<Repository["claim"]>>>;
type CoverResult =
  | { result: "ready" | "stale" }
  | {
      result: "failed";
      failureType: "prepare_or_render" | "upload" | "timeout" | "shutdown" | "commit";
    };

export function createSquareCoverJobs({
  repository,
  storage,
  socket,
  onResult,
}: {
  repository: Repository;
  storage: ObjectStore;
  socket: string;
  onResult: (event: { projectId: string; revisionId: string } & CoverResult) => void;
}) {
  let after: string | undefined;
  let sweepCursor: string | undefined;
  let sweepAt = 0;

  async function render(claim: RenderClaim, shutdown: AbortSignal) {
    const { projectId, revisionId } = claim;
    const signal = AbortSignal.any([shutdown, AbortSignal.timeout(JOB_TIMEOUT_MS)]);
    let stage: "prepare_or_render" | "upload" = "prepare_or_render";
    try {
      const image = await renderSquareCover({
        socket,
        projectKey: claim.projectKey,
        homepage: claim.homepagePath,
        files: claim.files,
        storage,
        signal,
      });
      stage = "upload";
      const signed = await storage.createPresignedUpload({
        key: claim.key,
        contentLength: image.length,
        contentType: "image/jpeg",
        contentMd5: createHash("md5").update(image).digest("base64"),
        expiresInSeconds: 60,
        internal: true,
      });
      const result = await fetch(signed.url, {
        method: "PUT",
        headers: signed.headers,
        body: new Uint8Array(image),
        signal,
        redirect: "error",
      });
      await result.body?.cancel();
      if (!result.ok) throw new Error("IMAGE_UPLOAD_FAILED");
    } catch {
      const failureType = shutdown.aborted ? "shutdown" : signal.aborted ? "timeout" : stage;
      onResult({ projectId, revisionId, result: "failed", failureType });
      await repository.fail(claim, new Date());
      return;
    }

    // A transport error during commit is ambiguous. Keep the object until the
    // next sweep can establish that the database no longer references it.
    try {
      const complete = await repository.complete(claim, new Date());
      if (!complete) await repository.fail(claim, new Date());
      onResult({ projectId, revisionId, result: complete ? "ready" : "stale" });
    } catch {
      onResult({ projectId, revisionId, result: "failed", failureType: "commit" });
    }
  }

  async function sweep(shutdown: AbortSignal) {
    const now = Date.now();
    if (now < sweepAt) return;
    sweepAt = now + SWEEP_INTERVAL_MS;
    const page = await storage.listObjects({
      prefix: SQUARE_COVER_PREFIX,
      ...(sweepCursor ? { continuationToken: sweepCursor } : {}),
      maxKeys: 100,
      timeoutMs: 5_000,
      abortSignal: AbortSignal.any([shutdown, AbortSignal.timeout(5_000)]),
    });
    const keys = page.keys.filter((key) => key.startsWith(SQUARE_COVER_PREFIX));
    if (keys.length) {
      // Each upload uses a fresh lease ID and is referenced before its PUT.
      const referenced = new Set(await repository.referencedImages(keys));
      await storage.deleteObjects(keys.filter((key) => !referenced.has(key)));
    }
    sweepCursor = page.nextContinuationToken;
  }

  return {
    async tick(shutdown: AbortSignal) {
      const renderAvailable = await isSquareRendererReady(socket, shutdown);
      const candidates = await repository.scan(after, SCAN_BATCH);
      for (const candidate of candidates) {
        shutdown.throwIfAborted();
        const claim = await repository.claim(candidate, new Date(), renderAvailable);
        after = candidate.id;
        if (claim) {
          await render(claim, shutdown);
          break;
        }
      }
      if (
        candidates.length === 0 ||
        (after === candidates.at(-1)?.id && candidates.length < SCAN_BATCH)
      )
        after = undefined;
      await sweep(shutdown);
    },
  };
}
