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
  return {
    async upsertUser(input) {
      const tenant = await prisma.tenant.upsert({
        where: { dingtalkAppKeyRef: input.tenantAppKeyRef },
        create: {
          dingtalkAppKeyRef: input.tenantAppKeyRef,
          name: "HTML Share organization",
        },
        update: {},
      });
      const user = await prisma.user.upsert({
        where: {
          tenantId_dingtalkUserId: {
            tenantId: tenant.id,
            dingtalkUserId: input.dingtalkUserId,
          },
        },
        create: {
          displayName: input.displayName,
          dingtalkUserId: input.dingtalkUserId,
          ...(input.dingtalkUnionId ? { dingtalkUnionId: input.dingtalkUnionId } : {}),
          lastLoginAt: input.now,
          tenantId: tenant.id,
        },
        update: {
          ...(input.dingtalkUnionId ? { dingtalkUnionId: input.dingtalkUnionId } : {}),
          displayName: input.displayName,
          lastLoginAt: input.now,
        },
      });
      return { id: user.id };
    },

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
      await prisma.accessSession.create({
        data: {
          audience: toDatabaseAudience(input.audience),
          expiresAt: input.expiresAt,
          tokenDigest: input.tokenDigest,
          userId: input.userId,
        },
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
  dingtalkUserId: string;
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
