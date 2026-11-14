import { createHash } from "node:crypto";
import {
  AccountLinkError,
  accountContactCutoff,
  normalizeAccountContacts,
  type DingTalkIdentity,
  type FeishuIdentity,
} from "@html-share/core";
interface UserRow {
  id: string;
  status: string;
  dingtalkUserId: string | null;
}
interface FeishuRow {
  userId: string;
  feishuAppId: string;
  feishuTenantKey: string;
  feishuOpenId: string;
}
interface UserData {
  displayName: string;
  lastLoginAt: Date;
  dingtalkUserId?: string;
  dingtalkUnionId?: string;
}
interface ContactData {
  phone: string | null;
  email: string | null;
  observedAt: Date;
}
// Narrow scalar-only surface shared by both generated clients, without casting clients.
interface IdentityTransaction {
  user: {
    findUnique(args: { where: { id: string } }): Promise<UserRow | null>;
    findUniqueOrThrow(args: { where: { id: string } }): Promise<UserRow>;
    findFirst(args: {
      where: { tenantId: string; dingtalkUserId: string };
    }): Promise<UserRow | null>;
    update(args: { where: { id: string }; data: UserData }): Promise<UserRow>;
    create(args: { data: UserData & { tenantId: string } }): Promise<UserRow>;
  };
  feishuIdentity: {
    findUnique(args: {
      where:
        { tenantId_identityKey: { tenantId: string; identityKey: string } } | { userId: string };
    }): Promise<FeishuRow | null>;
    create(args: { data: FeishuRow & { tenantId: string; identityKey: string } }): Promise<unknown>;
  };
  accountContact: {
    findMany(args: {
      where: {
        tenantId: string;
        observedAt: { gte: Date };
        OR: ({ phone: string } | { email: string })[];
      };
      select: { userId: true; phone: true; email: true };
    }): Promise<{ userId: string; phone: string | null; email: string | null }[]>;
    upsert(args: {
      where: { userId_provider: { userId: string; provider: string } };
      create: ContactData & { tenantId: string; userId: string; provider: string };
      update: ContactData;
    }): Promise<unknown>;
  };
}
export type LoginIdentity = (DingTalkIdentity | FeishuIdentity) & {
  now: Date;
  tenantAppKeyRef: string;
};

/** Caller holds the tenant row lock until this entire operation commits. */
export async function linkAccount(tx: IdentityTransaction, tenantId: string, input: LoginIdentity) {
  const feishu = "feishuOpenId" in input;
  const provider = feishu ? "feishu" : "dingtalk";
  const contacts = normalizeAccountContacts(input);
  const identityKey = feishu
    ? createHash("sha256")
        .update(JSON.stringify([input.feishuAppId, input.feishuTenantKey, input.feishuOpenId]))
        .digest("hex")
    : "";
  const linked = feishu
    ? await tx.feishuIdentity.findUnique({
        where: { tenantId_identityKey: { tenantId, identityKey } },
      })
    : null;
  if (
    linked &&
    feishu &&
    (linked.feishuAppId !== input.feishuAppId ||
      linked.feishuTenantKey !== input.feishuTenantKey ||
      linked.feishuOpenId !== input.feishuOpenId)
  ) {
    throw new AccountLinkError("ACCOUNT_LINK_CONFLICT");
  }
  let user = feishu
    ? linked
      ? await tx.user.findUnique({ where: { id: linked.userId } })
      : null
    : await tx.user.findFirst({ where: { tenantId, dingtalkUserId: input.dingtalkUserId } });
  if (user && !feishu && user.dingtalkUserId !== input.dingtalkUserId)
    throw new AccountLinkError("ACCOUNT_LINK_CONFLICT");
  if (user && user.status !== "ACTIVE") throw new AccountLinkError("ACCOUNT_DISABLED");
  if (!user) {
    const matches = await tx.accountContact.findMany({
      where: {
        tenantId,
        observedAt: { gte: accountContactCutoff(input.now) },
        OR: [
          ...(contacts.phone ? [{ phone: contacts.phone }] : []),
          ...(contacts.email ? [{ email: contacts.email }] : []),
        ],
      },
      select: { userId: true, phone: true, email: true },
    });
    // Compare source strings too: database collation must never broaden identity matches.
    const ids = new Set(
      matches
        .filter(
          (m) =>
            (contacts.phone !== null && m.phone === contacts.phone) ||
            (contacts.email !== null && m.email === contacts.email),
        )
        .map((m) => m.userId),
    );
    if (ids.size > 1) throw new AccountLinkError("ACCOUNT_LINK_CONFLICT");
    const id = [...ids][0];
    if (id) {
      user = await tx.user.findUniqueOrThrow({ where: { id } });
      if (user.status !== "ACTIVE") throw new AccountLinkError("ACCOUNT_DISABLED");
      const occupied = feishu
        ? await tx.feishuIdentity.findUnique({ where: { userId: id } })
        : user.dingtalkUserId;
      if (occupied !== null) throw new AccountLinkError("ACCOUNT_LINK_CONFLICT");
    }
  }
  const data = {
    displayName: input.displayName,
    lastLoginAt: input.now,
    ...(!feishu
      ? {
          dingtalkUserId: input.dingtalkUserId,
          ...(input.dingtalkUnionId ? { dingtalkUnionId: input.dingtalkUnionId } : {}),
        }
      : {}),
  };
  user = user
    ? await tx.user.update({ where: { id: user.id }, data })
    : await tx.user.create({ data: { ...data, tenantId } });
  if (feishu && !linked)
    await tx.feishuIdentity.create({
      data: {
        tenantId,
        userId: user.id,
        identityKey,
        feishuAppId: input.feishuAppId,
        feishuTenantKey: input.feishuTenantKey,
        feishuOpenId: input.feishuOpenId,
      },
    });
  // Replace the provider snapshot, including nulls; never retain a withdrawn contact.
  await tx.accountContact.upsert({
    where: { userId_provider: { userId: user.id, provider } },
    create: { tenantId, userId: user.id, provider, ...contacts, observedAt: input.now },
    update: { ...contacts, observedAt: input.now },
  });
  return { id: user.id };
}
