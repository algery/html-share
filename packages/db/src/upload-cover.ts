import { createHash } from "node:crypto";

import {
  resolveHomepage,
  UploadError,
  type DemoCoverUpload,
  type UploadRepository,
} from "@html-share/core";

import type { DatabaseConnection } from "./database-client.js";

interface CoverColumns {
  coverHomepagePath: string | null;
  coverContentMd5: string | null;
  coverSize: number | null;
  coverStorageKey: string | null;
}

export interface UploadPublicationInput {
  uploadId: string;
  now: Date;
  verifiedCoverKey?: string;
}

export function stagedCover(task: CoverColumns): DemoCoverUpload | undefined {
  if (
    task.coverHomepagePath === null ||
    task.coverStorageKey === null ||
    task.coverSize === null ||
    task.coverContentMd5 === null
  )
    return undefined;
  return {
    homepagePath: task.coverHomepagePath,
    contentMd5: task.coverContentMd5,
    size: task.coverSize,
    storageKey: task.coverStorageKey,
  };
}

export function effectiveUploadHomepage(
  files: readonly { relativePath: string }[],
  configuredPath: string | null,
  declaredPath: string | null,
) {
  const homepage = resolveHomepage(
    files.map((file) => file.relativePath),
    configuredPath,
  ).path;
  return declaredPath === null || homepage === declaredPath ? homepage : null;
}

export async function prepareCoverUpload(
  connection: DatabaseConnection,
  input: Parameters<UploadRepository["prepareCover"]>[0],
): Promise<DemoCoverUpload & { expiresAt: Date }> {
  async function readTask() {
    const args = {
      where: { id: input.uploadId, ownerUserId: input.ownerUserId },
      select: {
        id: true,
        projectId: true,
        tenantId: true,
        status: true,
        expiresAt: true,
        coverHomepagePath: true,
        coverContentMd5: true,
        coverSize: true,
        coverStorageKey: true,
        project: { select: { homepagePath: true, status: true, tenantId: true } },
        uploadFiles: { select: { relativePath: true } },
      },
    } as const;
    const task =
      connection.provider === "mysql"
        ? await connection.client.uploadTask.findFirst(args)
        : await connection.client.uploadTask.findFirst(args);
    if (!task || task.project.status === "DELETED" || task.tenantId !== task.project.tenantId)
      throw new UploadError("UPLOAD_NOT_FOUND");
    if (task.expiresAt <= input.now || task.status === "EXPIRED")
      throw new UploadError("UPLOAD_EXPIRED");
    if (
      task.status !== "PREPARED" ||
      input.homepagePath !==
        effectiveUploadHomepage(task.uploadFiles, task.project.homepagePath, task.coverHomepagePath)
    )
      throw new UploadError("INVALID_UPLOAD_INPUT");
    return task;
  }

  let task = await readTask();
  if (task.coverStorageKey === null) {
    const data = {
      coverHomepagePath: input.homepagePath,
      coverContentMd5: input.contentMd5,
      coverSize: input.size,
      coverStorageKey: `square-covers/${task.projectId}/${task.id}.jpg`,
    };
    const args = {
      data,
      where: {
        id: task.id,
        ownerUserId: input.ownerUserId,
        expiresAt: { gt: input.now },
        status: "PREPARED",
        coverStorageKey: null,
      },
    } as const;
    const reserved =
      connection.provider === "mysql"
        ? await connection.client.uploadTask.updateMany(args)
        : await connection.client.uploadTask.updateMany(args);
    if (reserved.count === 1) task = { ...task, ...data };
    else task = await readTask();
  }

  // A retry can reissue a URL for the same bytes only. Any prior signed URL
  // may remain valid after publication, so the declaration never changes.
  const cover = stagedCover(task);
  if (
    !cover ||
    cover.homepagePath !== input.homepagePath ||
    cover.contentMd5 !== input.contentMd5 ||
    cover.size !== input.size
  )
    throw new UploadError("INVALID_UPLOAD_INPUT");
  return { ...cover, expiresAt: task.expiresAt };
}

export function publishedCoverData(
  task: CoverColumns & {
    revisionId: string;
    tenantId: string;
    uploadFiles: readonly { relativePath: string }[];
  },
  currentHomepagePath: string | null,
  input: UploadPublicationInput,
  publicationNow: Date,
) {
  const cover = stagedCover(task);
  if (
    !cover ||
    cover.storageKey !== input.verifiedCoverKey ||
    cover.homepagePath !== effectiveUploadHomepage(task.uploadFiles, currentHomepagePath, null)
  )
    return undefined;

  return {
    tenantId: task.tenantId,
    revisionId: task.revisionId,
    homepagePath: cover.homepagePath,
    targetHash: createHash("sha256").update(cover.storageKey).digest("hex"),
    status: "ready",
    attempts: 0,
    nextAttemptAt: publicationNow,
    leaseId: null,
    leasedUntil: null,
    privateImageKey: cover.storageKey,
    width: 960,
    height: 600,
    generatedAt: publicationNow,
  };
}
