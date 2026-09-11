import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "./generated/prisma/client.js";
import { createProjectReader } from "./project-reader.js";

describe("project reader", () => {
  it("reads all current files in path order for an active project owned by the caller", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      createdAt: new Date("2026-09-07T00:00:00Z"),
      updatedAt: new Date("2026-09-07T00:00:00Z"),
      displayName: "Demo",
      fileCount: 2,
      projectKey: "abc12",
      totalSize: 15n,
      currentRevision: {
        files: [
          { relativePath: "assets/a.js", size: 12n },
          { relativePath: "index.html", size: 3n },
        ],
      },
    });
    const reader = createProjectReader({ demoProject: { findFirst } } as unknown as PrismaClient);
    const result = await reader.findOwnedActiveProject({
      ownerUserId: "owner-1",
      projectKey: "abc12",
    });
    expect(result).toMatchObject({
      totalSize: 15,
      files: [
        { relativePath: "assets/a.js", size: 12 },
        { relativePath: "index.html", size: 3 },
      ],
    });
    expect(result).not.toHaveProperty("currentRevision");
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          ownerUserId: "owner-1",
          projectKey: "abc12",
          status: "ACTIVE",
          currentRevision: { is: { status: "ACTIVE" } },
        },
        select: expect.objectContaining({
          currentRevision: {
            select: {
              files: {
                orderBy: { relativePath: "asc" },
                select: { relativePath: true, size: true },
              },
            },
          },
        }),
      }),
    );
  });

  it("returns no detail when there is no owned active project or no published revision", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ currentRevision: null });
    const reader = createProjectReader({ demoProject: { findFirst } } as unknown as PrismaClient);
    const input = { ownerUserId: "owner-1", projectKey: "abc12" };
    await expect(reader.findOwnedActiveProject(input)).resolves.toBeNull();
    await expect(reader.findOwnedActiveProject(input)).resolves.toBeNull();
  });

  it("only exposes an exact file from an ACTIVE current revision", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      currentRevision: {
        files: [
          {
            contentHash: "a".repeat(64),
            relativePath: "assets/a.js",
            size: 12n,
            storageKey: "projects/abc12/revisions/3/assets/a.js",
          },
        ],
      },
    });
    const reader = createProjectReader({
      demoProject: { findFirst },
    } as unknown as PrismaClient);

    await expect(
      reader.findCurrentFile({
        projectKey: "abc12",
        relativePath: "assets/a.js",
        tenantId: "tenant-1",
      }),
    ).resolves.toEqual({
      contentHash: "a".repeat(64),
      relativePath: "assets/a.js",
      size: 12,
      storageKey: "projects/abc12/revisions/3/assets/a.js",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          currentRevision: { is: { status: "ACTIVE" } },
          projectKey: "abc12",
          status: "ACTIVE",
          tenantId: "tenant-1",
        }),
      }),
    );
  });

  it("does not expose a deleted project, an obsolete revision, or a missing exact path", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const reader = createProjectReader({
      demoProject: { findFirst },
    } as unknown as PrismaClient);

    await expect(
      reader.findCurrentFile({
        projectKey: "abc12",
        relativePath: "old/index.html",
        tenantId: "tenant-1",
      }),
    ).resolves.toBeNull();
  });

  it("lists only active projects for the owner in update order with matching quota", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        createdAt: new Date("2026-09-03T00:00:00.000Z"),
        displayName: "Newer Demo",
        fileCount: 3,
        projectKey: "newer",
        totalSize: 24n,
        updatedAt: new Date("2026-09-03T02:00:00.000Z"),
      },
      {
        createdAt: new Date("2026-09-02T00:00:00.000Z"),
        displayName: "Older Demo",
        fileCount: 1,
        projectKey: "older",
        totalSize: 12n,
        updatedAt: new Date("2026-09-03T01:00:00.000Z"),
      },
    ]);
    const reader = createProjectReader({
      demoProject: { findMany },
    } as unknown as PrismaClient);

    await expect(reader.listOwnedActiveProjects({ ownerUserId: "owner-1" })).resolves.toEqual({
      projects: [
        expect.objectContaining({ projectKey: "newer", totalSize: 24 }),
        expect.objectContaining({ projectKey: "older", totalSize: 12 }),
      ],
      quota: { projectCount: 2, storageBytes: 36 },
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        where: { ownerUserId: "owner-1", status: "ACTIVE" },
      }),
    );
  });
});
