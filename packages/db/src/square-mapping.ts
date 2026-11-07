import { createHash } from "node:crypto";

import {
  emptySquareSettings,
  resolveHomepage,
  type SquareStoredCover,
  type SquareSettings,
  type SquareStoredProject,
  type SquareVisibility,
} from "@html-share/core";

export const squareProjectSelect = {
  id: true,
  projectKey: true,
  tenantId: true,
  currentRevisionId: true,
  displayName: true,
  fileCount: true,
  totalSize: true,
  homepagePath: true,
  updatedAt: true,
  squareSettings: { select: { settingsVersion: true } },
  owner: { select: { displayName: true } },
  squareCover: {
    select: {
      tenantId: true,
      revisionId: true,
      homepagePath: true,
      targetHash: true,
      status: true,
      privateImageKey: true,
    },
  },
  currentRevision: {
    select: {
      publishedAt: true,
      files: {
        orderBy: { relativePath: "asc" as const },
        select: { relativePath: true, size: true },
      },
    },
  },
} as const;

export function squareVisibleWhere(input: SquareVisibility) {
  const targets = input.member
    ? [
        { type: "user", subjectId: input.member.userId },
        { type: "department", subjectId: { in: input.member.departmentIds } },
      ]
    : [];
  return {
    tenantId: input.tenantId,
    status: "ACTIVE" as const,
    currentRevision: {
      is: { status: "ACTIVE" as const, tenantId: input.tenantId, publishedAt: { not: null } },
    },
    squareSettings: { is: { enabled: true, tenantId: input.tenantId } },
    OR: [
      { ownerUserId: input.userId },
      { squareSettings: { is: { audienceType: "organization" } } },
      ...(targets.length
        ? [
            {
              squareSettings: { is: { audienceType: "selected" } },
              squareAudience: { some: { tenantId: input.tenantId, OR: targets } },
            },
          ]
        : []),
    ],
  };
}

export function squareSearchWhere({ q, creator }: { q: string; creator?: string }) {
  const contains = (value: string) => ({ contains: value.replace(/[\\%_]/g, "\\$&") });
  return {
    ...(q ? { displayName: contains(q) } : {}),
    ...(creator ? { owner: { is: { displayName: contains(creator) } } } : {}),
  };
}

interface StoredCoverRow {
  tenantId: string;
  revisionId: string;
  homepagePath: string;
  targetHash: string;
  status: string;
  privateImageKey: string | null;
}

export function squareCoverTargetHash(input: {
  tenantId: string;
  projectId: string;
  revisionId: string;
  homepagePath: string;
  projectUpdatedAt: Date;
  settingsVersion: number;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.tenantId,
        input.projectId,
        input.revisionId,
        input.homepagePath,
        input.projectUpdatedAt.toISOString(),
        input.settingsVersion,
      ]),
    )
    .digest("hex");
}

export function squareProject(row: {
  id: string;
  projectKey: string;
  tenantId: string;
  currentRevisionId: string | null;
  squareCover: StoredCoverRow | null;
  displayName: string;
  fileCount: number;
  totalSize: bigint;
  homepagePath: string | null;
  updatedAt: Date;
  squareSettings: { settingsVersion: number } | null;
  owner: { displayName: string };
  currentRevision: {
    publishedAt: Date | null;
    files: { relativePath: string; size: bigint }[];
  } | null;
}): SquareStoredProject {
  if (!row.currentRevision?.publishedAt) throw new Error("SQUARE_INVALID_REVISION");
  const homepage = resolveHomepage(
    row.currentRevision.files.map((file) => file.relativePath),
    row.homepagePath,
  ).path;
  const cover = currentCover(row, homepage);
  return {
    ...(cover ? { cover } : {}),
    projectKey: row.projectKey,
    displayName: row.displayName,
    fileCount: row.fileCount,
    totalSize: Number(row.totalSize),
    homepagePath: row.homepagePath,
    creatorDisplayName: row.owner.displayName,
    updatedAt: row.currentRevision.publishedAt,
    files: row.currentRevision.files.map((file) => ({
      relativePath: file.relativePath,
      size: Number(file.size),
    })),
  };
}

function currentCover(
  project: Parameters<typeof squareProject>[0],
  homepage: string | null,
): SquareStoredCover | undefined {
  const { squareCover: row, currentRevisionId, tenantId, squareSettings } = project;
  if (!homepage) return undefined;
  if (
    !row ||
    !squareSettings ||
    !currentRevisionId ||
    row.tenantId !== tenantId ||
    row.revisionId !== currentRevisionId ||
    row.homepagePath !== homepage ||
    row.targetHash !==
      squareCoverTargetHash({
        tenantId,
        projectId: project.id,
        revisionId: currentRevisionId,
        homepagePath: homepage,
        projectUpdatedAt: project.updatedAt,
        settingsVersion: squareSettings.settingsVersion,
      })
  )
    return { status: "pending" };
  if (row.status === "ready" && row.privateImageKey)
    return { status: "ready", targetHash: row.targetHash, privateImageKey: row.privateImageKey };
  return { status: row.status === "failed" ? "failed" : "pending" };
}

export function squareSettings(
  row: {
    enabled: boolean;
    audienceType: string | null;
    settingsVersion: number;
    selectedDepartments: unknown;
    selectedUsers: unknown;
  } | null,
  audience: { type: string; subjectId: string }[],
): SquareSettings {
  if (!row) return emptySquareSettings();
  return {
    enabled: row.enabled,
    audienceType:
      row.audienceType === "organization" || row.audienceType === "selected"
        ? row.audienceType
        : null,
    settingsVersion: row.settingsVersion,
    departmentIds: audience
      .filter((target) => target.type === "department")
      .map((target) => target.subjectId),
    userIds: audience.filter((target) => target.type === "user").map((target) => target.subjectId),
    selectedDepartments: departments(row.selectedDepartments),
    selectedUsers: users(row.selectedUsers),
  };
}
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
      )
    : [];
}
function departments(value: unknown): SquareSettings["selectedDepartments"] {
  return records(value).flatMap((item) =>
    typeof item["id"] === "string" &&
    typeof item["name"] === "string" &&
    (item["parentId"] === null || typeof item["parentId"] === "string") &&
    typeof item["path"] === "string" &&
    typeof item["hasChildren"] === "boolean"
      ? [
          {
            id: item["id"],
            name: item["name"],
            parentId: item["parentId"],
            path: item["path"],
            hasChildren: item["hasChildren"],
          },
        ]
      : [],
  );
}
function users(value: unknown): SquareSettings["selectedUsers"] {
  return records(value).flatMap((item) =>
    typeof item["id"] === "string" &&
    typeof item["name"] === "string" &&
    Array.isArray(item["departmentPaths"])
      ? [
          {
            id: item["id"],
            name: item["name"],
            departmentPaths: item["departmentPaths"].filter(
              (path): path is string => typeof path === "string",
            ),
          },
        ]
      : [],
  );
}
