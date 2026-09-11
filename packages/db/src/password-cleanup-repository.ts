import type { PrismaClient } from "./generated/prisma/client.js";

const CLEANUP_BATCH_SIZE = 100;
const PASSWORD_RESULT_WINDOW_MS = 24 * 60 * 60 * 1_000;

export function createPasswordCleanupRepository(prisma: PrismaClient) {
  return {
    async cleanupExpired(now: Date): Promise<{ results: number; grants: number }> {
      // Each statement commits independently and locks only the rows it mutates.
      // Never acquire project locks after task locks: publication uses project → task.
      const results = await prisma.$executeRaw`
        WITH expired_results AS (
          SELECT "id" FROM "upload_tasks"
          WHERE (
            "encrypted_password_result" IS NOT NULL OR
            "pending_encrypted_password" IS NOT NULL OR
            "pending_password_hash" IS NOT NULL
          )
            AND (
              "password_result_expires_at" <= ${now}
              OR "created_at" <= ${new Date(now.getTime() - PASSWORD_RESULT_WINDOW_MS)}
              OR "status" IN ('FAILED', 'EXPIRED')
            )
          ORDER BY "created_at", "id"
          FOR UPDATE SKIP LOCKED
          LIMIT ${CLEANUP_BATCH_SIZE}
        )
        UPDATE "upload_tasks" AS task
        SET "encrypted_password_result" = NULL,
            "pending_encrypted_password" = NULL,
            "pending_password_hash" = NULL,
            "password_result_expires_at" = NULL,
            "updated_at" = ${now}
        FROM expired_results
        WHERE task."id" = expired_results."id"
      `;
      const grants = await prisma.$executeRaw`
        WITH expired_grants AS (
          SELECT "id" FROM "password_access_grants"
          WHERE "expires_at" <= ${now} OR "revoked_at" IS NOT NULL
          ORDER BY "expires_at", "id"
          FOR UPDATE SKIP LOCKED
          LIMIT ${CLEANUP_BATCH_SIZE}
        )
        DELETE FROM "password_access_grants" AS access_grant
        USING expired_grants
        WHERE access_grant."id" = expired_grants."id"
      `;
      return { results, grants };
    },
  };
}
