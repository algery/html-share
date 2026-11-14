import { AccountLinkError } from "@html-share/core";
import { linkAccount, type LoginIdentity } from "./account-identity.js";
import { PrismaPg } from "@prisma/adapter-pg";

import type {
  AccessSessionRecord,
  AuthRepository,
  AuthStateRecord,
  SessionAudience,
} from "@html-share/core";

import { AccessAudience, PrismaClient } from "./generated/prisma/client.js";

export function createPrismaClient(databaseUrl: string) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

export function createAuthRepository(prisma: PrismaClient): AuthRepository {
  async function upsertIdentity(input: LoginIdentity) {
    return prisma.$transaction(
      async (tx) => {
        // Native ON CONFLICT plus this row lock serialize both providers in one organization.
        await tx.$executeRaw`INSERT INTO tenants (id, name, dingtalk_app_key_ref, updated_at)
        VALUES (gen_random_uuid(), 'demo share organization', ${input.tenantAppKeyRef}, ${input.now})
        ON CONFLICT (dingtalk_app_key_ref) DO NOTHING`;
        const tenants = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status FROM tenants WHERE dingtalk_app_key_ref = ${input.tenantAppKeyRef} FOR UPDATE`;
        const tenant = tenants[0];
        if (!tenant || tenant.status !== "ACTIVE") throw new AccountLinkError("ACCOUNT_DISABLED");
        return linkAccount(tx, tenant.id, input);
      },
      { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000 },
    );
  }
  return {
    upsertUser: upsertIdentity,
    upsertFeishuUser: upsertIdentity,

    async createAuthState(input) {
      await prisma.authState.create({
        data: {
          audience: toDatabaseAudience(input.audience),
          expiresAt: input.expiresAt,
          returnPath: input.returnPath,
          stateDigest: input.stateDigest,
        },
      });
    },

    async consumeAuthState(input): Promise<AuthStateRecord | null> {
      const updated = await prisma.authState.updateMany({
        where: {
          consumedAt: null,
          expiresAt: { gt: input.now },
          stateDigest: input.stateDigest,
        },
        data: { consumedAt: input.now },
      });
      if (updated.count !== 1) {
        return null;
      }
      const state = await prisma.authState.findUniqueOrThrow({
        where: { stateDigest: input.stateDigest },
        select: { audience: true, returnPath: true },
      });
      return { audience: fromDatabaseAudience(state.audience), returnPath: state.returnPath };
    },

    async createAccessSession(input) {
      await prisma.$transaction(async (tx) => {
        // Lock tenant before user, matching identity-upsert lock order.
        const tenants = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM tenants WHERE id = (SELECT tenant_id FROM users WHERE id = ${input.userId}::uuid)
            AND status = 'ACTIVE' FOR SHARE`;
        const users = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM users WHERE id = ${input.userId}::uuid AND status = 'ACTIVE' FOR SHARE`;
        if (tenants.length !== 1 || users.length !== 1)
          throw new AccountLinkError("ACCOUNT_DISABLED");
        await tx.accessSession.create({
          data: {
            audience: toDatabaseAudience(input.audience),
            expiresAt: input.expiresAt,
            tokenDigest: input.tokenDigest,
            userId: input.userId,
          },
        });
      });
    },

    async findAccessSession(input): Promise<AccessSessionRecord | null> {
      const session = await prisma.accessSession.findFirst({
        where: {
          audience: toDatabaseAudience(input.audience),
          expiresAt: { gt: input.now },
          revokedAt: null,
          tokenDigest: input.tokenDigest,
          user: { status: "ACTIVE", tenant: { status: "ACTIVE" } },
        },
        include: { user: true },
      });
      if (session === null) {
        return null;
      }
      return {
        audience: fromDatabaseAudience(session.audience),
        expiresAt: session.expiresAt,
        id: session.id,
        tenantId: session.user.tenantId,
        user: asIdentity(session.user),
      };
    },

    async revokeAccessSession(input) {
      await prisma.accessSession.updateMany({
        where: {
          audience: toDatabaseAudience(input.audience),
          revokedAt: null,
          tokenDigest: input.tokenDigest,
        },
        data: { revokedAt: input.now },
      });
    },
  };
}

function asIdentity(user: {
  id: string;
  dingtalkUserId: string | null;
  dingtalkUnionId: string | null;
  displayName: string;
}) {
  return {
    dingtalkUserId: user.dingtalkUserId,
    ...(user.dingtalkUnionId ? { dingtalkUnionId: user.dingtalkUnionId } : {}),
    displayName: user.displayName,
    id: user.id,
  };
}

function toDatabaseAudience(audience: SessionAudience): AccessAudience {
  return audience === "app" ? AccessAudience.APP : AccessAudience.DEMO;
}

function fromDatabaseAudience(audience: AccessAudience): SessionAudience {
  return audience === AccessAudience.APP ? "app" : "demo";
}
