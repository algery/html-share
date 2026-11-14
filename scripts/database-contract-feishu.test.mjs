import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { databaseContract } from "./database-contract-fixture.mjs";

const now = new Date("2026-11-14T08:00:00.123Z");
function identities(f) {
  const scope = { tenantAppKeyRef: f.tenant.dingtalkAppKeyRef, now, displayName: "飞书契约成员" };
  return {
    ding: { ...scope, dingtalkUserId: randomUUID() },
    feishu: {
      ...scope,
      feishuAppId: "cli_test",
      feishuTenantKey: "test_tenant",
      feishuOpenId: randomUUID(),
    },
  };
}

databaseContract("Feishu account linking", (current) => {
  it("links both provider orders by normalized contacts and preserves user and asset keys", async () => {
    const f = current();
    for (const first of ["dingtalk", "feishu"]) {
      const { ding, feishu } = identities(f);
      const phone = first === "dingtalk" ? "13800138000" : "13900139000";
      const email = `${randomUUID()}@example.com`;
      const a =
        first === "dingtalk"
          ? await f.repositories.auth.upsertUser({ ...ding, phone, email })
          : await f.repositories.auth.upsertFeishuUser({ ...feishu, phone, email });
      const before = await f.db.user.findUniqueOrThrow({ where: { id: a.id } });
      const b =
        first === "dingtalk"
          ? await f.repositories.auth.upsertFeishuUser({
              ...feishu,
              phone: `+86 ${phone}`,
            })
          : await f.repositories.auth.upsertUser({
              ...ding,
              email: ` ${email.toUpperCase()} `,
            });
      expect(b).toEqual(a);
      const after = await f.db.user.findUniqueOrThrow({ where: { id: a.id } });
      expect(after.createdAt).toEqual(before.createdAt);
      expect(after.tenantId).toBe(before.tenantId);
      expect(after.dingtalkUserId).toBe(ding.dingtalkUserId);
      expect(await f.db.accountContact.count({ where: { userId: a.id } })).toBe(2);
      expect(await f.db.feishuIdentity.count({ where: { userId: a.id } })).toBe(1);
    }
  });

  it("enriches a legacy DingTalk account without changing its Demo, Token or quota", async () => {
    const f = current();
    const { feishu } = identities(f);
    const project = await f.project();
    const token = await f.db.mcpToken.create({
      data: {
        userId: f.owner.id,
        name: "legacy",
        tokenDigest: randomUUID(),
        tokenSuffix: "abcd",
        expiresAt: null,
      },
    });
    const beforeProjects = await f.db.demoProject.findMany({ where: { ownerUserId: f.owner.id } });
    const beforeReservations = await f.db.quotaReservation.findMany({
      where: { userId: f.owner.id },
    });
    await f.repositories.auth.upsertUser({
      tenantAppKeyRef: f.tenant.dingtalkAppKeyRef,
      now,
      displayName: f.owner.displayName,
      dingtalkUserId: f.owner.dingtalkUserId,
      email: "legacy@example.com",
    });
    expect(
      await f.repositories.auth.upsertFeishuUser({ ...feishu, email: "legacy@example.com" }),
    ).toEqual({ id: f.owner.id });
    expect(await f.db.demoProject.findMany({ where: { ownerUserId: f.owner.id } })).toEqual(
      beforeProjects,
    );
    expect(await f.db.quotaReservation.findMany({ where: { userId: f.owner.id } })).toEqual(
      beforeReservations,
    );
    expect(await f.db.mcpToken.findUnique({ where: { id: token.id } })).toEqual(token);
    expect(project.stored.ownerUserId).toBe(f.owner.id);
  });

  it("serializes concurrent cross-provider first logins and replayed identity logins", async () => {
    const f = current();
    const { ding, feishu } = identities(f);
    const email = `${randomUUID()}@example.com`;
    const users = await Promise.all([
      f.repositories.auth.upsertUser({ ...ding, email }),
      f.second.auth.upsertFeishuUser({ ...feishu, email }),
      f.repositories.auth.upsertFeishuUser({ ...feishu, email }),
      f.second.auth.upsertUser({ ...ding, email }),
    ]);
    expect(new Set(users.map((user) => user.id)).size).toBe(1);
    expect(await f.db.feishuIdentity.count({ where: { tenantId: f.tenant.id } })).toBe(1);
  });

  it("rejects split contacts, ambiguous contacts and same-source occupancy", async () => {
    const f = current();
    const { ding, feishu } = identities(f);
    const a = await f.repositories.auth.upsertUser({ ...ding, phone: "13800138000" });
    const other = { ...ding, dingtalkUserId: randomUUID(), email: "other@example.com" };
    await f.repositories.auth.upsertUser(other);
    await expect(
      f.repositories.auth.upsertFeishuUser({ ...feishu, phone: "13800138000", email: other.email }),
    ).rejects.toMatchObject({ code: "ACCOUNT_LINK_CONFLICT" });
    await expect(
      f.repositories.auth.upsertUser({
        ...other,
        dingtalkUserId: randomUUID(),
        phone: "13800138000",
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_LINK_CONFLICT" });
    // A stable provider may update its snapshot to a duplicate contact, but cannot move accounts.
    expect(await f.repositories.auth.upsertUser({ ...ding, email: other.email })).toEqual(a);
    await expect(
      f.repositories.auth.upsertFeishuUser({ ...feishu, email: other.email }),
    ).rejects.toMatchObject({ code: "ACCOUNT_LINK_CONFLICT" });
  });

  it("never reassigns established identities or merges established accounts", async () => {
    const f = current();
    const { ding, feishu } = identities(f);
    const a = await f.repositories.auth.upsertUser(ding);
    const b = await f.repositories.auth.upsertFeishuUser(feishu);
    expect(a).not.toEqual(b);
    await f.repositories.auth.upsertUser({ ...ding, email: "same@example.com" });
    expect(
      await f.repositories.auth.upsertFeishuUser({ ...feishu, email: "same@example.com" }),
    ).toEqual(b);
    expect(await f.repositories.auth.upsertUser({ ...ding, email: "same@example.com" })).toEqual(a);
    await expect(
      f.repositories.auth.upsertFeishuUser({
        ...feishu,
        feishuOpenId: randomUUID(),
        email: "same@example.com",
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_LINK_CONFLICT" });
  });

  it("blocks disabled users, matching disabled users, disabled tenants and ordinary DingTalk sessions", async () => {
    const f = current();
    const { ding, feishu } = identities(f);
    const a = await f.repositories.auth.upsertUser({ ...ding, email: "disabled@example.com" });
    await f.db.user.update({ where: { id: a.id }, data: { status: "DISABLED" } });
    await expect(f.repositories.auth.upsertUser(ding)).rejects.toMatchObject({
      code: "ACCOUNT_DISABLED",
    });
    await expect(
      f.repositories.auth.upsertFeishuUser({ ...feishu, email: "disabled@example.com" }),
    ).rejects.toMatchObject({ code: "ACCOUNT_DISABLED" });
    await expect(
      f.repositories.auth.createAccessSession({
        userId: a.id,
        tokenDigest: randomUUID(),
        audience: "app",
        expiresAt: new Date(now.getTime() + 3600000),
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_DISABLED" });
    expect(await f.db.accessSession.count({ where: { userId: a.id } })).toBe(0);
    await f.db.tenant.update({ where: { id: f.tenant.id }, data: { status: "DISABLED" } });
    await expect(f.repositories.auth.upsertFeishuUser(feishu)).rejects.toMatchObject({
      code: "ACCOUNT_DISABLED",
    });
    await expect(
      f.repositories.auth.upsertUser({ ...ding, dingtalkUserId: randomUUID() }),
    ).rejects.toMatchObject({ code: "ACCOUNT_DISABLED" });
  });

  it("clears missing or masked contacts and excludes snapshots older than 30 days", async () => {
    const f = current();
    for (const variant of ["missing", "masked", "stale"]) {
      const { ding, feishu } = identities(f);
      const email = `${randomUUID()}@example.com`;
      const a = await f.repositories.auth.upsertUser({ ...ding, email });
      if (variant !== "stale")
        await f.repositories.auth.upsertUser({
          ...ding,
          ...(variant === "masked" ? { email: "a***@example.com" } : {}),
        });
      const b = await f.repositories.auth.upsertFeishuUser({
        ...feishu,
        email,
        ...(variant === "stale" ? { now: new Date(now.getTime() + 31 * 86400000) } : {}),
      });
      expect(b).not.toEqual(a);
    }
  });

  it("keeps each provider's current contacts independently when the other omits them", async () => {
    const f = current();
    const { ding, feishu } = identities(f);
    const a = await f.repositories.auth.upsertUser({ ...ding, phone: "13800138000" });
    await f.repositories.auth.upsertFeishuUser({ ...feishu, phone: "13800138000" });
    await f.repositories.auth.upsertUser(ding);
    const rows = await f.db.accountContact.findMany({
      where: { userId: a.id },
      orderBy: { provider: "asc" },
    });
    expect(rows.map((row) => [row.provider, row.phone])).toEqual([
      ["dingtalk", null],
      ["feishu", "+8613800138000"],
    ]);
  });

  it("does not merge empty contacts, nicknames, email aliases or different tenant scope", async () => {
    const f = current();
    const { ding, feishu } = identities(f);
    const original = await f.repositories.auth.upsertUser({
      ...ding,
      email: "a.b+tag@example.com",
    });
    for (const email of [undefined, "ab+tag@example.com", "a.b@example.com", "invalid"]) {
      const result = await f.repositories.auth.upsertFeishuUser({
        ...feishu,
        feishuOpenId: randomUUID(),
        email,
      });
      expect(result).not.toEqual(original);
    }
    const other = await f.db.tenant.create({
      data: { dingtalkAppKeyRef: randomUUID(), name: "other" },
    });
    try {
      const result = await f.repositories.auth.upsertFeishuUser({
        ...feishu,
        tenantAppKeyRef: other.dingtalkAppKeyRef,
        email: "a.b+tag@example.com",
      });
      expect(result).not.toEqual(original);
    } finally {
      await f.db.user.deleteMany({ where: { tenantId: other.id } });
      await f.db.tenant.delete({ where: { id: other.id } });
    }
  });

  it("keeps exact Feishu app/tenant/open identity strings under case and trailing-space changes", async () => {
    const f = current();
    const { feishu } = identities(f);
    const identitiesToCreate = [
      feishu,
      { ...feishu, feishuOpenId: feishu.feishuOpenId.toUpperCase() },
      { ...feishu, feishuOpenId: `${feishu.feishuOpenId} ` },
      { ...feishu, feishuAppId: "CLI_TEST" },
      { ...feishu, feishuTenantKey: "test_tenant " },
    ];
    const results = [];
    for (const identity of identitiesToCreate)
      results.push(await f.repositories.auth.upsertFeishuUser(identity));
    expect(new Set(results.map((result) => result.id)).size).toBe(identitiesToCreate.length);
    expect(await f.repositories.auth.upsertFeishuUser(feishu)).toEqual(results[0]);
  });
});
