import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

import { databaseContract, manifest } from "./database-contract-fixture.mjs";
import { organization, save, selected, square } from "./database-contract-square-fixture.mjs";

databaseContract("square cover leases, current target and authorization", (current) => {
  it("generates for existing shared projects and prevents stale or unauthorized reads", async () => {
    const f = current();
    const api = square(f);
    const { prepared, stored } = await f.project({
      files: manifest(["index.html", "other.html"]),
    });
    const projectKey = prepared.projectId;
    const owner = { tenantId: f.tenant.id, userId: f.owner.id, projectKey };
    const outsider = { ...owner, userId: randomUUID(), unionId: "outside" };
    const { squareCovers: covers } = f.repositories;
    const candidate = async () =>
      (await covers.scan(undefined, 25)).find((p) => p.id === stored.id);
    const listCover = async () => (await api.service.listProjects(owner)).projects[0]?.cover;
    expect(await candidate()).toBeUndefined();
    await save(f, api.service, projectKey, selected());
    expect(await listCover()).toEqual({ status: "pending" });

    const snapshot = await candidate();
    const claims = await Promise.all([
      covers.claim(snapshot, f.now),
      f.second.squareCovers.claim(snapshot, f.now),
    ]);
    const [first] = claims.filter(Boolean);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(first.homepagePath).toBe("index.html");
    expect(await covers.referencedImages([first.key])).toEqual([first.key]);
    expect(await covers.complete(first, f.now)).toBe(true);
    expect(await listCover()).toEqual({
      status: "ready",
      path: `/api/square/projects/${projectKey}/cover/${first.targetHash}`,
    });
    const firstRequest = { ...owner, targetHash: first.targetHash };
    expect(await api.service.getCover(firstRequest)).toBe(first.key);
    api.setMember({ userId: "outside", departmentIds: [] });
    await expect(
      api.service.getCover({ ...outsider, targetHash: first.targetHash }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      api.service.getCover({ ...firstRequest, tenantId: randomUUID() }),
    ).rejects.toMatchObject({ statusCode: 404 });

    await f.db.demoProject.update({
      where: { id: stored.id },
      data: { homepagePath: "other.html" },
    });
    await expect(api.service.getCover(firstRequest)).rejects.toMatchObject({ statusCode: 404 });
    const second = await covers.claim(await candidate(), new Date());
    expect(second.homepagePath).toBe("other.html");
    expect(await covers.referencedImages([first.key, second.key])).toEqual([second.key]);
    await f.db.demoProject.update({
      where: { id: stored.id },
      data: { homepagePath: "index.html" },
    });
    expect(await covers.complete(second, new Date())).toBe(false);
    await covers.fail(second, new Date());
    expect(await listCover()).toEqual({ status: "pending" });
    await expect(api.service.getCover(firstRequest)).rejects.toMatchObject({ statusCode: 404 });
    const third = await covers.claim(await candidate(), new Date());
    expect(await covers.complete(third, new Date())).toBe(true);

    await save(f, api.service, projectKey, { enabled: false, settingsVersion: 1 });
    const thirdRequest = { ...owner, targetHash: third.targetHash };
    expect(await listCover()).toBeUndefined();
    await expect(api.service.getCover(thirdRequest)).rejects.toMatchObject({ statusCode: 404 });
    await save(f, api.service, projectKey, organization(2));
    expect(await listCover()).toEqual({ status: "pending" });
    await expect(api.service.getCover(thirdRequest)).rejects.toMatchObject({ statusCode: 404 });

    const fourth = await covers.claim(await candidate(), new Date());
    expect(await covers.complete(fourth, new Date())).toBe(true);
    expect(await api.service.getCover({ ...owner, targetHash: fourth.targetHash })).toBe(
      fourth.key,
    );
    await f.db.demoProject.update({ where: { id: stored.id }, data: { status: "DELETED" } });
    await expect(
      api.service.getCover({ ...owner, targetHash: fourth.targetHash }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await covers.claim(await candidate(), new Date())).toBeNull();
    expect(await covers.referencedImages([first.key, second.key, third.key, fourth.key])).toEqual(
      [],
    );
  });

  it("preserves the old cover during failed replacement and rejects a stale revision after publication", async () => {
    const f = current();
    const api = square(f);
    const { prepared, stored } = await f.project();
    const projectKey = prepared.projectId;
    const owner = { tenantId: f.tenant.id, userId: f.owner.id, projectKey };
    const { squareCovers: covers } = f.repositories;
    const candidate = async () =>
      (await covers.scan(undefined, 25)).find((p) => p.id === stored.id);
    await save(f, api.service, projectKey, organization());
    const first = await covers.claim(await candidate(), f.now);
    expect(await covers.complete(first, f.now)).toBe(true);
    const request = { ...owner, targetHash: first.targetHash };

    const replacement = await f.service.prepare(
      f.request({ action: "replace", projectId: projectKey }),
    );
    expect(await api.service.getCover(request)).toBe(first.key);
    f.setNow(new Date(f.now.getTime() + 1_000));
    await f.publish(replacement);
    await expect(api.service.getCover(request)).rejects.toMatchObject({ statusCode: 404 });
    const second = await covers.claim(await candidate(), f.now);
    expect(second.revisionId).not.toBe(first.revisionId);
    expect(await covers.complete(first, f.now)).toBe(false);
    await covers.fail(second, f.now);
    for (const minutes of [1, 2]) {
      const now = new Date(f.now.getTime() + minutes * 60_000);
      const retry = await covers.claim(await candidate(), now);
      expect(retry.attempts).toBe(minutes + 1);
      await covers.fail(retry, now);
    }
    expect((await api.service.listProjects(owner)).projects[0].cover).toEqual({ status: "failed" });
    expect(await covers.claim(await candidate(), new Date(f.now.getTime() + 180_000))).toBeNull();
  });
});
