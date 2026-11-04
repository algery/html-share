import { mysqlTransaction } from "./transaction.js";
import type { MysqlClient } from "./types.js";

const CLEANUP_BATCH_SIZE = 100;
const PASSWORD_RESULT_WINDOW_MS = 24 * 60 * 60 * 1_000;

export function createMysqlPasswordCleanupRepository(prisma: MysqlClient) {
  return {
    async cleanupExpired(now: Date): Promise<{ results: number; grants: number }> {
      // Separate short transactions avoid taking project locks after task locks.
      const results = await mysqlTransaction(prisma, async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM upload_tasks
          WHERE (encrypted_password_result IS NOT NULL OR pending_encrypted_password IS NOT NULL
            OR pending_password_hash IS NOT NULL)
            AND (password_result_expires_at <= ${now}
              OR created_at <= ${new Date(now.getTime() - PASSWORD_RESULT_WINDOW_MS)}
              OR status IN ('FAILED', 'EXPIRED'))
          ORDER BY created_at, id LIMIT ${CLEANUP_BATCH_SIZE} FOR UPDATE SKIP LOCKED
        `;
        if (rows.length === 0) return 0;
        const changed = await tx.uploadTask.updateMany({
          data: {
            encryptedPasswordResult: null,
            pendingEncryptedPassword: null,
            pendingPasswordHash: null,
            passwordResultExpiresAt: null,
            updatedAt: now,
          },
          where: { id: { in: rows.map((row) => row.id) } },
        });
        return changed.count;
      });
      const grants = await mysqlTransaction(prisma, async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM password_access_grants
          WHERE expires_at <= ${now} OR revoked_at IS NOT NULL
          ORDER BY expires_at, id LIMIT ${CLEANUP_BATCH_SIZE} FOR UPDATE SKIP LOCKED
        `;
        if (rows.length === 0) return 0;
        const removed = await tx.passwordAccessGrant.deleteMany({
          where: { id: { in: rows.map((row) => row.id) } },
        });
        return removed.count;
      });
      return { results, grants };
    },
  };
}
