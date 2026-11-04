import { randomUUID } from "node:crypto";
import type { AuthRepository, SessionAudience } from "@html-share/core";
import { AccessAudience } from "../generated/prisma-mysql/client.js";
import { assertSameText, textDigest } from "./path-identity.js";
import { mysqlTransaction } from "./transaction.js";
import type { MysqlClient } from "./types.js";

export function createMysqlAuthRepository(prisma: MysqlClient): AuthRepository {
  return {
    upsertUser(input) {
      return mysqlTransaction(prisma, async (tx) => {
        // The generated digest index arbitrates concurrent first logins. Never
        // update identity data until its complete source string is verified.
        await tx.$executeRaw`INSERT INTO tenants
          (id, name, dingtalk_app_key_ref, updated_at)
          VALUES (${randomUUID()}, 'HTML Share organization', ${input.tenantAppKeyRef}, ${input.now})
          ON DUPLICATE KEY UPDATE id = id`;
        const tenants = await tx.$queryRaw<{ id: string; appKey: string }[]>`
          SELECT id, dingtalk_app_key_ref AS appKey FROM tenants
          WHERE app_key_digest = ${textDigest(input.tenantAppKeyRef)} FOR UPDATE`;
        const tenant = tenants[0];
        if (!tenant) throw new Error("DATABASE_IDENTITY_NOT_FOUND");
        assertSameText(tenant.appKey, input.tenantAppKeyRef);
        await tx.$executeRaw`INSERT INTO users
          (id, tenant_id, dingtalk_user_id, display_name, last_login_at, updated_at)
          VALUES (${randomUUID()}, ${tenant.id}, ${input.dingtalkUserId},
            ${input.displayName}, ${input.now}, ${input.now})
          ON DUPLICATE KEY UPDATE id = id`;
        const users = await tx.$queryRaw<{ id: string; dingtalkUserId: string }[]>`
          SELECT id, dingtalk_user_id AS dingtalkUserId FROM users
          WHERE tenant_id = ${tenant.id}
            AND dingtalk_user_digest = ${textDigest(input.dingtalkUserId)} FOR UPDATE`;
        const user = users[0];
        if (!user) throw new Error("DATABASE_IDENTITY_NOT_FOUND");
        assertSameText(user.dingtalkUserId, input.dingtalkUserId);
        await tx.user.update({
          where: { id: user.id },
          data: { displayName: input.displayName, lastLoginAt: input.now },
        });
        return { id: user.id };
      });
    },

    async createAuthState(input) {
      await prisma.authState.create({
        data: { ...input, audience: toDatabaseAudience(input.audience) },
      });
    },

    consumeAuthState(input) {
      return mysqlTransaction(prisma, async (tx) => {
        const states = await tx.$queryRaw<
          {
            id: string;
            stateDigest: string;
            audience: AccessAudience;
            returnPath: string;
          }[]
        >`SELECT id, state_digest AS stateDigest, audience, return_path AS returnPath
          FROM auth_states WHERE state_digest_hash = ${textDigest(input.stateDigest)}
            AND consumed_at IS NULL AND expires_at > ${input.now} FOR UPDATE`;
        const state = states[0];
        if (!state) return null;
        assertSameText(state.stateDigest, input.stateDigest);
        await tx.authState.update({ where: { id: state.id }, data: { consumedAt: input.now } });
        return { audience: fromDatabaseAudience(state.audience), returnPath: state.returnPath };
      });
    },

    async createAccessSession(input) {
      await prisma.accessSession.create({
        data: { ...input, audience: toDatabaseAudience(input.audience) },
      });
    },

    async findAccessSession(input) {
      const identity = await findSessionIdentity(prisma, input.tokenDigest);
      if (identity === null) return null;
      const session = await prisma.accessSession.findFirst({
        where: {
          id: identity,
          audience: toDatabaseAudience(input.audience),
          expiresAt: { gt: input.now },
          revokedAt: null,
          tokenDigest: input.tokenDigest,
          user: { status: "ACTIVE", tenant: { status: "ACTIVE" } },
        },
        include: { user: true },
      });
      if (!session) return null;
      assertSameText(session.tokenDigest, input.tokenDigest);
      return {
        audience: fromDatabaseAudience(session.audience),
        expiresAt: session.expiresAt,
        id: session.id,
        tenantId: session.user.tenantId,
        user: {
          id: session.user.id,
          dingtalkUserId: session.user.dingtalkUserId,
          displayName: session.user.displayName,
        },
      };
    },

    async revokeAccessSession(input) {
      const identity = await findSessionIdentity(prisma, input.tokenDigest);
      if (identity === null) return;
      await prisma.accessSession.updateMany({
        where: {
          id: identity,
          audience: toDatabaseAudience(input.audience),
          revokedAt: null,
          tokenDigest: input.tokenDigest,
        },
        data: { revokedAt: input.now },
      });
    },
  };
}

async function findSessionIdentity(prisma: MysqlClient, tokenDigest: string) {
  const rows = await prisma.$queryRaw<{ id: string; tokenDigest: string }[]>`
    SELECT id, token_digest AS tokenDigest FROM access_sessions
    WHERE token_digest_hash = ${textDigest(tokenDigest)} LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  assertSameText(row.tokenDigest, tokenDigest);
  return row.id;
}

function toDatabaseAudience(audience: SessionAudience): AccessAudience {
  return audience === "app" ? AccessAudience.APP : AccessAudience.DEMO;
}

function fromDatabaseAudience(audience: AccessAudience): SessionAudience {
  return audience === AccessAudience.APP ? "app" : "demo";
}
