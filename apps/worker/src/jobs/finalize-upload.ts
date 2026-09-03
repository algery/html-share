import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { extractArchive, inspectArchive, type ArchiveValidationError } from "@html-share/core";
import type { ProcessingUpload, StoredFile } from "@html-share/db";
import type { ObjectStore } from "@html-share/storage";

export interface UploadFinalizerRepository {
  claimNextProcessingUpload(now: Date): Promise<ProcessingUpload | null>;
  publishUpload(input: {
    uploadId: string;
    files: readonly StoredFile[];
    totalSize: number;
    now: Date;
  }): Promise<boolean>;
  failUpload(input: { uploadId: string; failureCode: string; now: Date }): Promise<void>;
  recordStagedObjectKey(input: { uploadId: string; storageKey: string }): Promise<void>;
  markTemporaryObjectsCleaned(input: { objectKeys: readonly string[]; now: Date }): Promise<void>;
  listCleanupObjectKeys(now: Date): Promise<string[]>;
}

const DELETE_BATCH_SIZE = 1000;

export async function finalizeNextUpload(input: {
  repository: UploadFinalizerRepository;
  storage: ObjectStore;
  now?: () => Date;
}): Promise<"idle" | "published" | "failed"> {
  const now = input.now ?? (() => new Date());
  const task = await input.repository.claimNextProcessingUpload(now());
  if (task === null) return "idle";
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "html-share-upload-"));
  const archivePath = join(temporaryDirectory, "upload.zip");
  const writtenKeys: string[] = [];
  let published = false;
  try {
    const archiveMetadata = await input.storage.headObject(task.temporaryObjectKey);
    if (archiveMetadata === null || archiveMetadata.size !== task.declaredArchiveSize) {
      throw new FinalizeError("ARCHIVE_UPLOAD_SIZE_MISMATCH");
    }
    const archive = await input.storage.getObject(task.temporaryObjectKey);
    await pipeline(archive, createWriteStream(archivePath, { flags: "wx" }));
    const entries = await inspectArchive(archivePath);
    const declaredTotalSize = entries.reduce((total, entry) => total + entry.uncompressedSize, 0);
    if (entries.length !== task.declaredFileCount || declaredTotalSize !== task.declaredTotalSize) {
      throw new FinalizeError("ARCHIVE_DECLARATION_MISMATCH");
    }
    const extracted = await extractArchive({
      entries,
      putFile: async (file) => {
        const storageKey = revisionStorageKey(task, file.path);
        await input.repository.recordStagedObjectKey({ storageKey, uploadId: task.uploadId });
        writtenKeys.push(storageKey);
        await input.storage.putObject({
          body: file.body,
          contentType: file.mimeType,
          key: storageKey,
          size: file.size,
        });
      },
      zipPath: archivePath,
    });
    if (extracted.manifestDigest !== task.manifestDigest)
      throw new FinalizeError("ARCHIVE_MANIFEST_MISMATCH");
    if (!extracted.files.some((file) => file.path === task.targetHtml)) {
      throw new FinalizeError("TARGET_HTML_MISSING");
    }
    const publicationCommitted = await input.repository.publishUpload({
      files: extracted.files.map((file) => ({
        ...file,
        storageKey: revisionStorageKey(task, file.path),
      })),
      now: now(),
      totalSize: extracted.totalSize,
      uploadId: task.uploadId,
    });
    if (!publicationCommitted) throw new FinalizeError("PUBLISH_NOT_APPLIED");
    published = true;
    await deleteTemporaryObject(input, task.temporaryObjectKey, now());
    return "published";
  } catch (error) {
    if (!published) {
      await input.storage
        .deleteObjects([...writtenKeys, task.temporaryObjectKey])
        .catch(() => undefined);
      await input.repository.failUpload({
        failureCode: errorCode(error),
        now: now(),
        uploadId: task.uploadId,
      });
      return "failed";
    }
    return "published";
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

export async function cleanupUploadArtifacts(input: {
  repository: UploadFinalizerRepository;
  storage: ObjectStore;
  now?: () => Date;
}) {
  const keys = await input.repository.listCleanupObjectKeys((input.now ?? (() => new Date()))());
  for (const batch of batches(keys, DELETE_BATCH_SIZE)) {
    await input.storage.deleteObjects(batch);
  }
  await input.repository.markTemporaryObjectsCleaned({
    now: (input.now ?? (() => new Date()))(),
    objectKeys: keys,
  });
  return keys.length;
}

function* batches<T>(items: readonly T[], size: number) {
  for (let index = 0; index < items.length; index += size) yield items.slice(index, index + size);
}

async function deleteTemporaryObject(
  input: Pick<Parameters<typeof finalizeNextUpload>[0], "repository" | "storage">,
  key: string,
  now: Date,
) {
  try {
    await input.storage.deleteObjects([key]);
    await input.repository.markTemporaryObjectsCleaned({ now, objectKeys: [key] });
  } catch {
    // The completed revision is already active. Cleanup remains retriable and must never roll it back.
  }
}

function revisionStorageKey(task: ProcessingUpload, path: string) {
  return `projects/${task.projectKey}/revisions/${task.revisionNumber}/${path}`;
}

function errorCode(error: unknown) {
  if (error instanceof FinalizeError) return error.code;
  if (isArchiveValidationError(error)) return error.code;
  return "UPLOAD_FINALIZATION_FAILED";
}

function isArchiveValidationError(error: unknown): error is ArchiveValidationError {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ArchiveValidationError" &&
    "code" in error
  );
}

class FinalizeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
