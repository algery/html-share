import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { databaseContract, manifest } from "./database-contract-fixture.mjs";

import {
  square,
  owner,
  save,
  organization,
  selected,
  publishedTime,
} from "./database-contract-square-fixture.mjs";

// These tests use only independent temporary contract databases, never a user's app database.
databaseContract("project square access and atomic persistence", (current) => {
  it("defaults off, filters before count/search, uses verified enterprise IDs and preserves content settings", async () => {
    const f = current();
    const api = square(f);
    const { prepared, stored } = await f.project();
    const projectKey = prepared.projectId;
    const viewer = { tenantId: f.tenant.id, userId: randomUUID(), unionId: "trusted-union" };
    expect(await api.service.getSettings(owner(f, projectKey))).toMatchObject({
      enabled: false,
      audienceType: null,
      settingsVersion: 0,
    });
    expect(await api.service.listProjects(viewer)).toMatchObject({ total: 0 });
    expect(
      (await f.repositories.projects.listOwnedActiveProjects({ ownerUserId: f.owner.id }))
        .projects[0].squareEnabled,
    ).toBe(false);
    await save(f, api.service, projectKey, selected());
    expect(await f.db.demoProject.findUniqueOrThrow({ where: { id: stored.id } })).toEqual(stored);
    expect((await api.service.listProjects(viewer)).total).toBe(1);
    expect((await api.service.getProject({ ...viewer, projectKey })).project.updatedAt).toEqual(
      await publishedTime(f, projectKey),
    );
    expect(
      (await f.repositories.projects.listOwnedActiveProjects({ ownerUserId: f.owner.id }))
        .projects[0].squareEnabled,
    ).toBe(true);
    api.setMember({ userId: "enterprisecase", departmentIds: ["20"] });
    expect(await api.service.listProjects({ ...viewer, q: stored.displayName })).toMatchObject({
      total: 0,
      projects: [],
    });
    await expect(api.service.getProject({ ...viewer, projectKey })).rejects.toMatchObject({
      statusCode: 404,
    });
    api.setMember({ userId: "EnterpriseCase", departmentIds: ["20"] });
    expect((await api.service.listProjects(viewer)).total).toBe(1);
    api.setMember({ userId: "different", departmentIds: ["11", "10", "1"] });
    expect((await api.service.listProjects(viewer)).total).toBe(1);
    expect((await api.service.listProjects({ ...viewer, tenantId: randomUUID() })).total).toBe(0);
    api.setUnavailable(true);
    expect(await api.service.listProjects(viewer)).toMatchObject({
      total: 0,
      directoryUnavailable: true,
    });
    expect((await api.service.listProjects({ ...viewer, userId: f.owner.id })).total).toBe(1);
    await expect(save(f, api.service, projectKey, selected(1))).rejects.toMatchObject({
      statusCode: 503,
    });
    expect((await api.service.getSettings(owner(f, projectKey))).settingsVersion).toBe(1);
    await save(f, api.service, projectKey, organization(1));
    expect((await api.service.listProjects(viewer)).total).toBe(1);
    await save(f, api.service, projectKey, { enabled: false, settingsVersion: 2 });
    expect(await api.service.listProjects(viewer)).toMatchObject({ total: 0 });
    expect(await api.service.getSettings(owner(f, projectKey))).toMatchObject({
      enabled: false,
      audienceType: "organization",
      settingsVersion: 3,
    });
    expect(
      await f.repositories.projects.findCurrentFile({
        tenantId: f.tenant.id,
        projectKey,
        relativePath: "index.html",
      }),
    ).not.toBeNull();
    const audits = await f.db.squareAuditLog.findMany({ where: { tenantId: f.tenant.id } });
    expect(audits.map((audit) => audit.result)).toContain("SQUARE_DIRECTORY_UNAVAILABLE");
    expect(audits.filter((audit) => audit.result === "success")).toHaveLength(3);
    expect(JSON.stringify(audits)).not.toContain("EnterpriseCase");
  });

  it("retains selected targets on disable, rejects strangers and records stale-write conflicts", async () => {
    const f = current();
    const api = square(f);
    const { prepared } = await f.project();
    const key = prepared.projectId;
    await save(f, api.service, key, selected());
    api.setUnavailable(true);
    await save(f, api.service, key, { enabled: false, settingsVersion: 1 });
    expect(await api.service.getSettings(owner(f, key))).toMatchObject({
      enabled: false,
      audienceType: "selected",
      departmentIds: ["10"],
      userIds: ["EnterpriseCase"],
    });
    await expect(save(f, api.service, key, organization(1))).rejects.toMatchObject({
      code: "SQUARE_VERSION_CONFLICT",
    });
    await expect(
      save(f, api.service, key, organization(2), { ownerUserId: randomUUID() }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      api.service.getSettings({ ...owner(f, key), tenantId: randomUUID() }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await api.service.getSettings(owner(f, key))).settingsVersion).toBe(2);
  });

  it("serializes concurrent writers, refuses active uploads, and rolls back settings if audit fails", async () => {
    const f = current();
    const api = square(f);
    const other = square(f, f.second.square);
    const { prepared, stored } = await f.project();
    const key = prepared.projectId;
    const results = await Promise.allSettled([
      save(f, api.service, key, selected()),
      save(f, other.service, key, organization()),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")[0].reason.code).toBe(
      "SQUARE_VERSION_CONFLICT",
    );
    const before = await api.service.getSettings(owner(f, key));
    await expect(
      save(f, api.service, key, organization(1), { requestIp: "x".repeat(65) }),
    ).rejects.toBeDefined();
    expect(await api.service.getSettings(owner(f, key))).toEqual(before);
    const replacement = await f.service.prepare(f.request({ action: "replace", projectId: key }));
    await expect(
      save(f, api.service, key, { enabled: false, settingsVersion: 1 }),
    ).rejects.toMatchObject({ code: "SQUARE_UPLOAD_CONFLICT" });
    expect(await api.service.getSettings(owner(f, key))).toEqual(before);
    await f.repositories.uploads.failUpload({
      uploadId: replacement.uploadId,
      failureCode: "contract_done",
      now: f.now,
    });
    expect(await f.db.demoProject.findUniqueOrThrow({ where: { id: stored.id } })).toEqual(stored);
    await save(f, api.service, key, { enabled: false, settingsVersion: 1 });
    expect((await api.service.getSettings(owner(f, key))).enabled).toBe(false);
  });

  it("shows only the current revision after replace and stops discovery after deletion", async () => {
    const f = current();
    const api = square(f);
    const { prepared } = await f.project();
    const key = prepared.projectId;
    const viewer = { tenantId: f.tenant.id, userId: randomUUID() };
    await save(f, api.service, key, organization());
    const before = await api.service.getProject({ ...viewer, projectKey: key });
    f.setNow(new Date(f.now.getTime() + 1000));
    const replacement = await f.service.prepare(
      f.request({ action: "replace", projectId: key, files: manifest(["中文/新 页面.html"]) }),
    );
    expect((await api.service.getProject({ ...viewer, projectKey: key })).files).toEqual(
      before.files,
    );
    await f.publish(replacement);
    const result = await api.service.getProject({ ...viewer, projectKey: key });
    expect(result.files.map((file) => file.relativePath)).toEqual(["中文/新 页面.html"]);
    expect(result.project.updatedAt).toEqual(await publishedTime(f, key));
    expect(Object.keys(result.project).sort()).toEqual([
      "creatorDisplayName",
      "displayName",
      "fileCount",
      "homepage",
      "projectId",
      "totalSize",
      "updatedAt",
    ]);
    expect(Object.keys(result.files[0]).sort()).toEqual(["relativePath", "size", "url"]);
    expect((await api.service.getSettings(owner(f, key))).settingsVersion).toBe(1);
    expect(
      await f.repositories.deletion.deleteAsOwner({
        projectKey: key,
        now: f.now,
        ownerUserId: f.owner.id,
      }),
    ).toBe("deleted");
    expect((await api.service.listProjects(viewer)).total).toBe(0);
    await expect(api.service.getProject({ ...viewer, projectKey: key })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("keeps legacy users, projects and token ownership when trusted unionId arrives", async () => {
    const f = current();
    const published = await f.project();
    const token = await f.repositories.mcpTokens.createToken({
      user: f.owner,
      name: "legacy",
      tokenDigest: randomUUID(),
      tokenSuffix: "abcd",
      createdAt: f.now,
      expiresAt: new Date(f.now.getTime() + 60_000),
    });
    const input = {
      tenantAppKeyRef: f.tenant.dingtalkAppKeyRef,
      dingtalkUserId: f.owner.dingtalkUserId,
      displayName: "重名不参与匹配",
      now: f.now,
    };
    expect(
      await f.repositories.auth.upsertUser({ ...input, dingtalkUnionId: "TrustedUnionCase" }),
    ).toEqual({ id: f.owner.id });
    expect(await f.repositories.auth.upsertUser(input)).toEqual({ id: f.owner.id });
    const user = await f.db.user.findUniqueOrThrow({ where: { id: f.owner.id } });
    expect(user.dingtalkUserId).toBe(f.owner.dingtalkUserId);
    expect(user.dingtalkUnionId).toBe("TrustedUnionCase");
    expect((await f.repositories.mcpTokens.listTokens({ userId: f.owner.id }))[0].id).toBe(
      token.id,
    );
    expect(
      (await f.db.demoProject.findUniqueOrThrow({ where: { id: published.stored.id } }))
        .ownerUserId,
    ).toBe(f.owner.id);
    const login = randomUUID();
    await f.repositories.auth.createAccessSession({
      userId: f.owner.id,
      tokenDigest: login,
      audience: "app",
      expiresAt: new Date(f.now.getTime() + 1000),
    });
    expect(
      (
        await f.repositories.auth.findAccessSession({
          tokenDigest: login,
          audience: "app",
          now: f.now,
        })
      ).user.dingtalkUnionId,
    ).toBe("TrustedUnionCase");
  });
  it("counts only visible matches, clamps pagination and sorts stable content timestamps", async () => {
    const f = current();
    const api = square(f);
    const keys = [];
    for (let index = 0; index < 13; index += 1) {
      const { prepared } = await f.project({
        displayName: index === 12 ? "HiddenSecret" : `Visible-${index}`,
      });
      await save(f, api.service, prepared.projectId, index === 12 ? selected() : organization());
      if (index < 12) keys.push(prepared.projectId);
    }
    const publishedAt = new Date("2026-11-01T00:00:00Z");
    await f.db.revision.updateMany({
      where: { tenantId: f.tenant.id, status: "ACTIVE" },
      data: { publishedAt },
    });
    const viewer = { tenantId: f.tenant.id, userId: randomUUID() };
    const page = await api.service.listProjects({ ...viewer, page: 99, pageSize: 10 });
    expect(page).toMatchObject({ total: 12, page: 2, pageSize: 10 });
    expect(page.projects.map((project) => project.projectId)).toEqual(keys.sort().slice(10));
    expect(
      page.projects.every((project) => project.updatedAt.getTime() === publishedAt.getTime()),
    ).toBe(true);
    expect(await api.service.listProjects({ ...viewer, q: "HiddenSecret" })).toMatchObject({
      projects: [],
      total: 0,
    });
    expect(await api.service.listProjects({ ...viewer, q: "%" })).toMatchObject({
      projects: [],
      total: 0,
    });
  });
  it("matches creator names literally and intersects project names within visible results", async () => {
    const f = current();
    const { service } = square(f);
    await f.db.user.update({ where: { id: f.owner.id }, data: { displayName: "张_三" } });
    const other = await f.db.user.create({
      data: {
        tenantId: f.tenant.id,
        dingtalkUserId: randomUUID(),
        displayName: "张二三",
        lastLoginAt: f.now,
      },
    });
    const visible = await f.project({ displayName: "产品公开" });
    const hidden = await f.project({ displayName: "产品限阅" });
    const second = await f.project({ displayName: "产品公开", owner: other });
    await save(f, service, visible.prepared.projectId, organization());
    await save(f, service, hidden.prepared.projectId, selected());
    await save(f, service, second.prepared.projectId, organization(), { ownerUserId: other.id });
    const viewer = { tenantId: f.tenant.id, userId: randomUUID() };
    expect(await service.listProjects({ ...viewer, creator: " 张 " })).toMatchObject({ total: 2 });
    expect(await service.listProjects({ ...viewer, creator: "_三", q: "产品" })).toMatchObject({
      total: 1,
      projects: [{ projectId: visible.prepared.projectId, creatorDisplayName: "张_三" }],
    });
    expect(await service.listProjects({ ...viewer, creator: "_三", q: "限阅" })).toMatchObject({
      total: 0,
      projects: [],
    });
  });
});
