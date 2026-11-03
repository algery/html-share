import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createPasswordAccessFixture, passwordDatabaseUrl } from "./password-access.test-helper.js";
import { createHomepageWriter } from "./project-homepage-repository.js";
import { createProjectReader } from "./project-reader.js";
import { resolveHomepage } from "@html-share/core";

const suite = passwordDatabaseUrl ? describe : describe.skip;
suite("persisted project homepage", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });
  it("persists the exact owned file, survives a new reader and clears back to automatic", async () => {
    const fixture = await createPasswordAccessFixture();
    cleanups.push(fixture.cleanup);
    const project = await fixture.project();
    const input = { ownerUserId: fixture.owner.id, projectKey: project.projectKey };
    const reader = createProjectReader(fixture.prisma);
    expect(
      await createHomepageWriter(fixture.prisma)({
        ...input,
        relativePath: project.path.relativePath,
      }),
    ).toBe("updated");
    const reloaded = await createProjectReader(fixture.prisma).findOwnedActiveProject(input);
    expect(reloaded?.homepagePath).toBe(project.path.relativePath);
    expect((await reader.listOwnedActiveProjects(input)).projects[0]).toMatchObject({
      homepagePath: project.path.relativePath,
      htmlPaths: [project.path.relativePath],
    });
    expect(await createHomepageWriter(fixture.prisma)({ ...input, relativePath: null })).toBe(
      "updated",
    );
    expect((await reader.findOwnedActiveProject(input))?.homepagePath).toBeNull();
  });
  it("rejects other owners, unpublished paths, assets and deleted projects", async () => {
    const fixture = await createPasswordAccessFixture();
    cleanups.push(fixture.cleanup);
    const project = await fixture.project();
    const writer = createHomepageWriter(fixture.prisma);
    const input = { ownerUserId: fixture.owner.id, projectKey: project.projectKey };
    expect(
      await writer({
        ...input,
        ownerUserId: randomUUID(),
        relativePath: project.path.relativePath,
      }),
    ).toBe("not_found");
    for (const path of [
      "missing.html",
      "../index.html",
      "https://evil.test/index.html",
      "assets/app.js",
    ]) {
      expect(await writer({ ...input, relativePath: path })).toBe("invalid_file");
    }
    await fixture.prisma.demoProject.update({
      where: { id: project.id },
      data: { status: "DELETED" },
    });
    expect(await writer({ ...input, relativePath: null })).toBe("not_found");
  });
  it("does not expose a stored homepage once the current revision no longer contains it", async () => {
    const fixture = await createPasswordAccessFixture();
    cleanups.push(fixture.cleanup);
    const project = await fixture.project();
    const reader = createProjectReader(fixture.prisma);
    const input = { ownerUserId: fixture.owner.id, projectKey: project.projectKey };
    await createHomepageWriter(fixture.prisma)({
      ...input,
      relativePath: project.path.relativePath,
    });
    const next = await fixture.prisma.revision.create({
      data: {
        tenantId: fixture.tenant.id,
        projectId: project.id,
        revisionNumber: 2,
        status: "ACTIVE",
      },
    });
    await fixture.prisma.demoProject.update({
      where: { id: project.id },
      data: { currentRevisionId: next.id },
    });
    const listed = (await reader.listOwnedActiveProjects(input)).projects[0];
    if (!listed) throw new Error("missing project");
    expect(resolveHomepage(listed.htmlPaths ?? [], listed.homepagePath)).toEqual({
      path: null,
      source: "missing",
    });
    expect(
      await createHomepageWriter(fixture.prisma)({
        ...input,
        relativePath: project.path.relativePath,
      }),
    ).toBe("invalid_file");
  });
  it("waits for a publication lock and rechecks the file after the revision switches", async () => {
    const fixture = await createPasswordAccessFixture();
    cleanups.push(fixture.cleanup);
    const project = await fixture.project();
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const publication = fixture.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM demo_projects WHERE id = ${project.id}::uuid FOR UPDATE`;
      locked();
      await held;
      await tx.fileObject.deleteMany({ where: { revisionId: project.revisionId } });
    });
    await ready;
    const write = createHomepageWriter(fixture.prisma)({
      ownerUserId: fixture.owner.id,
      projectKey: project.projectKey,
      relativePath: project.path.relativePath,
    });
    try {
      const deadline = Date.now() + 3000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const rows = await fixture.prisma.$queryRaw<
          { blocked: boolean }[]
        >`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock') AS blocked`;
        waiting = rows[0]?.blocked ?? false;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally {
      release();
      await publication;
    }
    expect(await write).toBe("invalid_file");
  });
});
