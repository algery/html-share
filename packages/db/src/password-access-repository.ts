import type { PasswordAccessRepository, PasswordAccessTarget } from "@html-share/core";
import { Prisma, type PrismaClient } from "./generated/prisma/client.js";

type QueryClient = Pick<PrismaClient, "$queryRaw">;

// Every relation is checked against both the immutable project UUID and tenant.
const currentFileJoins = Prisma.sql`
  FROM demo_projects p
  JOIN tenants t ON t.id = p.tenant_id AND t.status = 'ACTIVE'
  JOIN revisions r ON r.id = p.current_revision_id AND r.project_id = p.id
    AND r.tenant_id = p.tenant_id AND r.status = 'ACTIVE'
  JOIN file_objects f ON f.revision_id = r.id AND f.project_id = p.id
    AND f.tenant_id = p.tenant_id`;

async function findTarget(db: QueryClient, input: { projectKey: string; relativePath: string }) {
  const rows = await db.$queryRaw<PasswordAccessTarget[]>(Prisma.sql`
    SELECT p.id AS "projectId", p.tenant_id AS "tenantId", p.project_key AS "projectKey",
      p.access_mode AS "accessMode", p.password_version AS "passwordVersion",
      p.password_hash AS "passwordHash"
    ${currentFileJoins}
    WHERE p.project_key = ${input.projectKey} AND p.status = 'ACTIVE'
      AND p.access_mode IN ('organization', 'password') AND f.relative_path = ${input.relativePath}
    LIMIT 1`);
  return rows[0] ?? null;
}

export function createPasswordAccessRepository(prisma: PrismaClient): PasswordAccessRepository {
  return {
    findTarget: (input) => findTarget(prisma, input),

    async createGrant(input) {
      return prisma.$transaction(async (tx) => {
        // Match publication/deletion's project-first lock order. SHARE conflicts with
        // all project updates, including updates which do not change a unique key.
        await tx.$queryRaw`SELECT id FROM demo_projects
          WHERE id = ${input.target.projectId}::uuid FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM tenants
          WHERE id = ${input.target.tenantId}::uuid FOR SHARE`;
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
        }[]
      >(Prisma.sql`
        SELECT f.content_hash AS "contentHash", f.relative_path AS "relativePath", f.size,
          f.storage_key AS "storageKey",
          CASE WHEN p.tenant_id::text = ${input.tenantId} THEN 'organization:' || p.tenant_id::text
            ELSE 'password:' || g.id::text END AS principal
        ${currentFileJoins}
        LEFT JOIN password_access_grants g ON g.grant_hash = ${input.grantHash}
          AND g.project_id = p.id AND g.tenant_id = p.tenant_id
          AND g.password_version = p.password_version AND g.revoked_at IS NULL
          AND g.expires_at > ${input.now}
        WHERE p.project_key = ${input.projectKey} AND p.status = 'ACTIVE'
          AND p.access_mode IN ('organization', 'password')
          AND f.relative_path = ${input.relativePath}
          AND (p.tenant_id::text = ${input.tenantId}
            OR (p.access_mode = 'password' AND p.password_hash IS NOT NULL AND g.id IS NOT NULL))
        LIMIT 1`);
      const row = rows[0];
      if (!row) return null;
      const { principal, ...file } = row;
      return { file: { ...file, size: Number(file.size) }, principal };
    },
  };
}
