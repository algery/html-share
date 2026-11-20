import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

import { databaseContract, manifest } from "./database-contract-fixture.mjs";
import { organization, save, selected, square } from "./database-contract-square-fixture.mjs";

databaseContract("square cover visibility and compatibility", (current) => {
  it("shows an existing matching cover, rotates its URL with sharing and hides it after a change", async () => {
    const f = current();
    const api = square(f);
    const { prepared, stored } = await f.project({
      files: manifest(["index.html", "other.html"]),
    });
    const projectKey = prepared.projectId;
    const owner = { tenantId: f.tenant.id, userId: f.owner.id, projectKey };
    const { squareCovers: covers } = f.repositories;
    const listCover = async () => (await api.service.listProjects(owner)).projects[0]?.cover;
    await save(f, api.service, projectKey, selected());
    expect(await listCover()).toBeUndefined();

    const key = `square-covers/${stored.id}/legacy.jpg`;
    await f.db.projectSquareCover.create({
      data: {
        projectId: stored.id,
        tenantId: stored.tenantId,
        revisionId: stored.currentRevisionId,
        homepagePath: "index.html",
        targetHash: "a".repeat(64),
        status: "ready",
        privateImageKey: key,
        width: 960,
        height: 600,
      },
    });
    expect(await covers.referencedImages([key], f.now)).toEqual(new Set([key]));
    const first = await listCover();
    expect(first.status).toBe("ready");
    const request = { ...owner, targetHash: first.path.split("/").at(-1) };
    expect(await api.service.getCover(request)).toBe(key);
    api.setMember({ userId: "outside", departmentIds: [] });
    await expect(
      api.service.getCover({ ...request, userId: randomUUID(), unionId: "outside" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      api.service.getCover({ ...request, tenantId: randomUUID() }),
    ).rejects.toMatchObject({ statusCode: 404 });

    await save(f, api.service, projectKey, { enabled: false, settingsVersion: 1 });
    await expect(api.service.getCover(request)).rejects.toMatchObject({ statusCode: 404 });
    expect(await covers.referencedImages([key], f.now)).toEqual(new Set([key]));
    await save(f, api.service, projectKey, organization(2));
    const second = await listCover();
    expect(second.status).toBe("ready");
    expect(second.path).not.toBe(first.path);
    await expect(api.service.getCover(request)).rejects.toMatchObject({ statusCode: 404 });

    await f.db.demoProject.update({
      where: { id: stored.id },
      data: { homepagePath: "other.html" },
    });
    expect(await listCover()).toBeUndefined();
    await expect(
      api.service.getCover({ ...owner, targetHash: second.path.split("/").at(-1) }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await f.db.demoProject.update({ where: { id: stored.id }, data: { status: "DELETED" } });
    expect(await covers.referencedImages([key], f.now)).toEqual(new Set());
  });
});
