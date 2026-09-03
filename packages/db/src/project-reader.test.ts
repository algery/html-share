import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "./generated/prisma/client.js";
import { createProjectReader } from "./project-reader.js";

describe("project reader", () => {
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
