import { randomUUID } from "node:crypto";

import { resolveHomepage } from "@html-share/core";

import type { DatabaseConnection } from "./database-client.js";
import { isDatabaseUniqueViolation } from "./database-errors.js";
import { squareCoverTargetHash } from "./square-mapping.js";

export const SQUARE_COVER_PREFIX = "square-covers/";
const MAX_ATTEMPTS = 3;
const LEASE_MS = 60_000;

const selectProject = {
  id: true,
  projectKey: true,
  tenantId: true,
  status: true,
  currentRevisionId: true,
  homepagePath: true,
  updatedAt: true,
  squareSettings: { select: { enabled: true, settingsVersion: true, tenantId: true } },
  squareCover: true,
  currentRevision: {
    select: {
      tenantId: true,
      status: true,
      publishedAt: true,
      files: {
        take: 501,
        select: { relativePath: true, size: true, storageKey: true },
      },
    },
  },
} as const;

interface CoverRow {
  projectId: string;
  targetHash: string;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  leaseId: string | null;
  leasedUntil: Date | null;
  updatedAt: Date;
}

interface CoverProject {
  id: string;
  projectKey: string;
  tenantId: string;
  status: string;
  currentRevisionId: string | null;
  homepagePath: string | null;
  updatedAt: Date;
  squareSettings: { enabled: boolean; settingsVersion: number; tenantId: string } | null;
  squareCover: CoverRow | null;
  currentRevision: {
    tenantId: string;
    status: string;
    publishedAt: Date | null;
    files: { relativePath: string; size: bigint; storageKey: string }[];
  } | null;
}

function target(project: CoverProject) {
  const revision = project.currentRevision;
  if (
    project.status !== "ACTIVE" ||
    !project.squareSettings?.enabled ||
    project.squareSettings.tenantId !== project.tenantId ||
    !project.currentRevisionId ||
    !revision?.publishedAt ||
    revision.status !== "ACTIVE" ||
    revision.tenantId !== project.tenantId
  )
    return null;
  const homepagePath = resolveHomepage(
    revision.files.map((file) => file.relativePath),
    project.homepagePath,
  ).path;
  if (!homepagePath) return null;
  const targetHash = squareCoverTargetHash({
    tenantId: project.tenantId,
    projectId: project.id,
    revisionId: project.currentRevisionId,
    homepagePath,
    projectUpdatedAt: project.updatedAt,
    settingsVersion: project.squareSettings.settingsVersion,
  });
  return {
    projectId: project.id,
    tenantId: project.tenantId,
    revisionId: project.currentRevisionId,
    homepagePath,
    targetHash,
    files: revision.files,
  };
}

function unchanged(row: CoverRow) {
  return {
    projectId: row.projectId,
    targetHash: row.targetHash,
    leaseId: row.leaseId,
    status: row.status,
    updatedAt: row.updatedAt,
  };
}

export function createSquareCoverRepository(connection: DatabaseConnection) {
  async function readProject(id: string): Promise<CoverProject | null> {
    const args = { where: { id }, select: selectProject };
    return connection.provider === "mysql"
      ? connection.client.demoProject.findUnique(args)
      : connection.client.demoProject.findUnique(args);
  }

  return {
    async scan(after: string | undefined, take: number): Promise<CoverProject[]> {
      const args = {
        where: {
          ...(after ? { id: { gt: after } } : {}),
          OR: [{ squareSettings: { is: { enabled: true } } }, { squareCover: { isNot: null } }],
        },
        select: selectProject,
        orderBy: { id: "asc" as const },
        take,
      };
      return connection.provider === "mysql"
        ? connection.client.demoProject.findMany(args)
        : connection.client.demoProject.findMany(args);
    },

    async claim(project: CoverProject, now: Date, renderAvailable = true) {
      const row = project.squareCover;
      // A lease holder can still upload its unique object until the lease expires.
      if (row?.status === "running" && row.leasedUntil && row.leasedUntil > now) return null;
      const input = target(project);
      if (!input || (!renderAvailable && row?.targetHash !== input.targetHash)) {
        if (!row) return null;
        const args = { where: unchanged(row) };
        if (connection.provider === "mysql")
          await connection.client.projectSquareCover.deleteMany(args);
        else await connection.client.projectSquareCover.deleteMany(args);
        return null;
      }

      if (!renderAvailable) return null;
      const sameTarget = row?.targetHash === input.targetHash;
      if (
        sameTarget &&
        (row.status === "ready" || row.status === "failed" || row.nextAttemptAt > now)
      )
        return null;
      if (sameTarget && row.attempts >= MAX_ATTEMPTS) {
        const args = {
          where: unchanged(row),
          data: { status: "failed", leaseId: null, leasedUntil: null, privateImageKey: null },
        };
        if (connection.provider === "mysql")
          await connection.client.projectSquareCover.updateMany(args);
        else await connection.client.projectSquareCover.updateMany(args);
        return null;
      }

      const { files, ...identity } = input;
      const leaseId = randomUUID();
      const key = `${SQUARE_COVER_PREFIX}${project.id}/${leaseId}.jpg`;
      const attempts = sameTarget ? row.attempts + 1 : 1;
      const data = {
        ...identity,
        status: "running",
        attempts,
        leaseId,
        leasedUntil: new Date(now.getTime() + LEASE_MS),
        nextAttemptAt: now,
        privateImageKey: key,
        width: null,
        height: null,
        generatedAt: null,
      };

      if (row) {
        const args = { where: unchanged(row), data };
        const updated =
          connection.provider === "mysql"
            ? await connection.client.projectSquareCover.updateMany(args)
            : await connection.client.projectSquareCover.updateMany(args);
        if (updated.count !== 1) return null;
      } else {
        try {
          if (connection.provider === "mysql")
            await connection.client.projectSquareCover.create({ data });
          else await connection.client.projectSquareCover.create({ data });
        } catch (error) {
          if (isDatabaseUniqueViolation(error)) return null;
          throw error;
        }
      }

      return {
        ...identity,
        projectKey: project.projectKey,
        files,
        leaseId,
        key,
        attempts,
      };
    },

    async complete(claim: CoverLease, now: Date) {
      const project = await readProject(claim.projectId);
      if (!project || target(project)?.targetHash !== claim.targetHash) return false;
      const args = {
        where: { ...claimFilter(claim), leasedUntil: { gt: now } },
        data: {
          status: "ready",
          leaseId: null,
          leasedUntil: null,
          width: 960,
          height: 600,
          generatedAt: now,
        },
      };
      const updated =
        connection.provider === "mysql"
          ? await connection.client.projectSquareCover.updateMany(args)
          : await connection.client.projectSquareCover.updateMany(args);
      return updated.count === 1;
    },

    async fail(claim: CoverLease & { attempts: number }, now: Date) {
      const args = {
        where: claimFilter(claim),
        data: {
          status: claim.attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          leaseId: null,
          leasedUntil: null,
          nextAttemptAt: new Date(now.getTime() + 15_000 * claim.attempts),
          privateImageKey: null,
        },
      };
      if (connection.provider === "mysql")
        await connection.client.projectSquareCover.updateMany(args);
      else await connection.client.projectSquareCover.updateMany(args);
    },

    async referencedImages(keys: string[]) {
      const args = {
        where: { privateImageKey: { in: keys } },
        select: { privateImageKey: true },
      };
      const rows =
        connection.provider === "mysql"
          ? await connection.client.projectSquareCover.findMany(args)
          : await connection.client.projectSquareCover.findMany(args);
      return rows.flatMap(({ privateImageKey }) => (privateImageKey ? [privateImageKey] : []));
    },
  };
}

interface CoverLease {
  projectId: string;
  targetHash: string;
  leaseId: string;
}

function claimFilter(claim: CoverLease) {
  return {
    projectId: claim.projectId,
    targetHash: claim.targetHash,
    leaseId: claim.leaseId,
    status: "running",
  };
}
