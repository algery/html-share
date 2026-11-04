import type { PasswordAccessRepository, PasswordAccessTarget } from "@html-share/core";
import { Prisma } from "../generated/prisma-mysql/client.js";
import { assertSameText, textDigest } from "./path-identity.js";
import { mysqlTransaction } from "./transaction.js";
import type { MysqlClient } from "./types.js";

type QueryClient = Pick<MysqlClient, "$queryRaw">;

const currentFileJoins = Prisma.sql`
  FROM demo_projects p
  JOIN tenants t ON t.id = p.tenant_id AND t.status = 'ACTIVE'
  JOIN revisions r ON r.id = p.current_revision_id AND r.project_id = p.id
    AND r.tenant_id = p.tenant_id AND r.status = 'ACTIVE'
  JOIN file_objects f ON f.revision_id = r.id AND f.project_id = p.id
    AND f.tenant_id = p.tenant_id`;

async function findTarget(db: QueryClient, input: { projectKey: string; relativePath: string }) {
  const rows = await db.$queryRaw<(PasswordAccessTarget & { relativePath: string })[]>(Prisma.sql`
    SELECT p.id AS projectId, p.tenant_id AS tenantId, p.project_key AS projectKey,
      p.access_mode AS accessMode, p.password_version AS passwordVersion,
      p.password_hash AS passwordHash, f.relative_path AS relativePath
    ${currentFileJoins}
    WHERE p.project_key = ${input.projectKey} AND p.status = 'ACTIVE'
      AND p.access_mode IN ('organization', 'password')
      AND f.relative_path_digest = ${textDigest(input.relativePath)} LIMIT 1`);
  const row = rows[0];
  if (!row) return null;
  assertSameText(row.relativePath, input.relativePath);
  return {
    projectId: row.projectId,
    tenantId: row.tenantId,
    projectKey: row.projectKey,
    accessMode: row.accessMode,
    passwordVersion: row.passwordVersion,
    passwordHash: row.passwordHash,
  };
}

export function createMysqlPasswordAccessRepository(prisma: MysqlClient): PasswordAccessRepository {
  return {
    findTarget: (input) => findTarget(prisma, input),

    createGrant(input) {
      return mysqlTransaction(prisma, async (tx) => {
        // Project first matches publication, homepage and deletion. Retain both
        // SHARE locks until INSERT and recheck authorization after all waits.
        await tx.$queryRaw`SELECT id FROM demo_projects
          WHERE id = ${input.target.projectId} FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM tenants
          WHERE id = ${input.target.tenantId} FOR SHARE`;
        const current = await findTarget(tx, {
          projectKey: input.target.projectKey,
          relativePath: input.relativePath,
        });
        if (
          !current ||
          current.accessMode !== "password" ||
          !current.passwordHash ||
          current.projectId !== input.target.projectId ||
          current.tenantId !== input.target.tenantId ||
          current.passwordVersion !== input.target.passwordVersion ||
          current.passwordHash !== input.target.passwordHash ||
          input.expiresAt <= input.now
        )
          return false;
        await tx.passwordAccessGrant.create({
          data: {
            tenantId: current.tenantId,
            projectId: current.projectId,
            passwordVersion: current.passwordVersion,
            grantHash: input.grantHash,
            expiresAt: input.expiresAt,
            createdAt: input.now,
          },
        });
        return true;
      });
    },

    async authorizeFile(input) {
      const rows = await prisma.$queryRaw<
        {
          contentHash: string;
          relativePath: string;
          size: bigint;
          storageKey: string;
          principal: string;
          grantHash: string | null;
        }[]
      >(Prisma.sql`
        SELECT f.content_hash AS contentHash, f.relative_path AS relativePath, f.size,
          f.storage_key AS storageKey, g.grant_hash AS grantHash,
          CASE WHEN p.tenant_id = ${input.tenantId} THEN CONCAT('organization:', p.tenant_id)
            ELSE CONCAT('password:', g.id) END AS principal
        ${currentFileJoins}
        LEFT JOIN password_access_grants g
          ON g.grant_hash_digest = ${input.grantHash === null ? null : textDigest(input.grantHash)}
          AND g.project_id = p.id AND g.tenant_id = p.tenant_id
          AND g.password_version = p.password_version AND g.revoked_at IS NULL
          AND g.expires_at > ${input.now}
        WHERE p.project_key = ${input.projectKey} AND p.status = 'ACTIVE'
          AND p.access_mode IN ('organization', 'password')
          AND f.relative_path_digest = ${textDigest(input.relativePath)}
          AND (p.tenant_id = ${input.tenantId}
            OR (p.access_mode = 'password' AND p.password_hash IS NOT NULL AND g.id IS NOT NULL))
        LIMIT 1`);
      const row = rows[0];
      if (!row) return null;
      assertSameText(row.relativePath, input.relativePath);
      if (row.principal.startsWith("password:")) {
        if (input.grantHash === null || row.grantHash === null) return null;
        assertSameText(row.grantHash, input.grantHash);
      }
      return {
        file: {
          contentHash: row.contentHash,
          relativePath: row.relativePath,
          size: Number(row.size),
          storageKey: row.storageKey,
        },
        principal: row.principal,
      };
    },
  };
}
