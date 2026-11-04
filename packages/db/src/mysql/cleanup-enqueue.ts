import { isDatabaseUniqueViolation } from "../database-errors.js";
import type { CleanupJobKind } from "../generated/prisma-mysql/client.js";
import { assertSameText, textDigest } from "./path-identity.js";
import type { MysqlTransactionClient } from "./types.js";

export async function enqueueCleanupJob(
  tx: MysqlTransactionClient,
  data: { kind: CleanupJobKind; targetId: string; objectKeys: string[]; runAfter: Date },
) {
  const findExisting = async () => {
    const rows = await tx.$queryRaw<{ id: string; targetId: string }[]>`
      SELECT id, target_id AS targetId FROM cleanup_jobs
      WHERE kind = ${data.kind} AND target_id_digest = ${textDigest(data.targetId)}
    `;
    const existing = rows[0];
    if (existing !== undefined) assertSameText(existing.targetId, data.targetId);
    return existing;
  };
  const existing = await findExisting();
  if (existing !== undefined) return existing.id;
  try {
    return (await tx.cleanupJob.create({ data })).id;
  } catch (error) {
    // A digest-key race is the only accepted duplicate. All other failures escape.
    if (!isDatabaseUniqueViolation(error)) throw error;
    const raced = await findExisting();
    if (raced === undefined) throw error;
    return raced.id;
  }
}

export function readObjectKeys(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
