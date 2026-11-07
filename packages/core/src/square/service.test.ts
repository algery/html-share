import { describe, expect, it, vi } from "vitest";
import {
  emptySquareSettings,
  type SquareDirectoryGateway,
  type SquareRepository,
} from "./contracts.js";
import { createSquareService, parseSquareChange } from "./service.js";

const owner = { tenantId: "tenant", ownerUserId: "owner", projectKey: "abc12" };
const request = { ...owner, requestIp: "127.0.0.1", traceId: "trace" };
function setup() {
  const settings = {
    ...emptySquareSettings(),
    enabled: true,
    audienceType: "selected" as const,
    departmentIds: ["10"],
    settingsVersion: 3,
  };
  const repository: SquareRepository = {
    findOwnedSettings: vi.fn(async () => settings),
    saveOwnedSettings: vi.fn(async (input) => ({
      ...input.settings,
      settingsVersion: input.expectedVersion + 1,
    })),
    recordFailure: vi.fn(async () => undefined),
    listVisible: vi.fn(async () => ({ projects: [], total: 0, page: 1, pageSize: 10 })),
    findVisible: vi.fn(async () => null),
  };
  const directory: SquareDirectoryGateway = {
    getSnapshot: vi.fn(async () => ({
      limited: true,
      departments: [
        { id: "10", name: "产品", parentId: "1", path: "组织/产品", hasChildren: true },
      ],
      users: [{ id: "enterprise-1", name: "同名", departmentPaths: ["组织/研发"] }],
    })),
    resolveMember: vi.fn(async () => ({
      userId: "enterprise-1",
      departmentIds: ["11", "10", "1"],
    })),
  };
  return {
    repository,
    directory,
    settings,
    service: createSquareService({ repository, directory, demoWebUrl: "https://demo.example.com" }),
  };
}

describe("square domain service", () => {
  it("rejects unknown invalid inputs and requires a deliberate audience", () => {
    for (const input of [
      null,
      [],
      {},
      { enabled: true, settingsVersion: 0 },
      { enabled: "true", settingsVersion: 0 },
      { enabled: true, settingsVersion: -1 },
      { enabled: true, settingsVersion: 0, audienceType: "selected", userIds: [1] },
    ]) {
      expect(() => parseSquareChange(input)).toThrow();
    }
    expect(parseSquareChange({ enabled: false, settingsVersion: 0, userIds: "ignored" })).toEqual({
      enabled: false,
      settingsVersion: 0,
    });
  });
  it("validates owner before consulting the directory and records a redacted failure", async () => {
    const f = setup();
    vi.mocked(f.repository.findOwnedSettings).mockResolvedValue(null);
    await expect(
      f.service.saveSettings({
        ...request,
        change: {
          enabled: true,
          settingsVersion: 0,
          audienceType: "selected",
          departmentIds: ["10"],
        },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(f.directory.getSnapshot).not.toHaveBeenCalled();
    expect(f.repository.saveOwnedSettings).not.toHaveBeenCalled();
    expect(f.repository.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ result: "SQUARE_NOT_FOUND" }),
    );
  });
  it("disables without directory access and keeps previous targets", async () => {
    const f = setup();
    await expect(
      f.service.saveSettings({ ...request, change: { enabled: false, settingsVersion: 3 } }),
    ).resolves.toMatchObject({ enabled: false, departmentIds: ["10"], settingsVersion: 4 });
    expect(f.directory.getSnapshot).not.toHaveBeenCalled();
  });
  it("validates and deduplicates mixed selections against authorized tenant snapshot", async () => {
    const f = setup();
    const result = await f.service.saveSettings({
      ...request,
      change: {
        enabled: true,
        settingsVersion: 3,
        audienceType: "selected",
        departmentIds: ["10", "10"],
        userIds: ["enterprise-1"],
      },
    });
    expect(result).toMatchObject({
      departmentIds: ["10"],
      userIds: ["enterprise-1"],
      selectedUsers: [{ id: "enterprise-1", name: "同名", departmentPaths: ["组织/研发"] }],
    });
    expect(f.directory.getSnapshot).toHaveBeenCalledWith({ tenantId: owner.tenantId });
  });
  it.each([
    { audienceType: "selected", departmentIds: [], userIds: [] },
    { audienceType: "organization", departmentIds: ["10"] },
    { audienceType: "selected", userIds: ["openId-is-not-enterprise-id"] },
    { audienceType: "selected", departmentIds: Array.from({ length: 101 }, (_, i) => String(i)) },
  ])("rejects invalid or unauthorized selection without any partial save", async (change) => {
    const f = setup();
    await expect(
      f.service.saveSettings({
        ...request,
        change: { ...change, enabled: true, settingsVersion: 3 },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(f.repository.saveOwnedSettings).not.toHaveBeenCalled();
  });
  it("preserves previous sharing when the directory fails and permits organization sharing", async () => {
    const f = setup();
    vi.mocked(f.directory.getSnapshot).mockRejectedValue(new Error("upstream private details"));
    await expect(
      f.service.saveSettings({
        ...request,
        change: {
          enabled: true,
          settingsVersion: 3,
          audienceType: "selected",
          departmentIds: ["10"],
        },
      }),
    ).rejects.toMatchObject({ code: "SQUARE_DIRECTORY_UNAVAILABLE", statusCode: 503 });
    expect(f.repository.saveOwnedSettings).not.toHaveBeenCalled();
    await expect(
      f.service.saveSettings({
        ...request,
        change: { enabled: true, settingsVersion: 3, audienceType: "organization" },
      }),
    ).resolves.toMatchObject({ audienceType: "organization", departmentIds: [] });
  });
  it("passes only verified enterprise membership and fails closed on unavailable lookup", async () => {
    const f = setup();
    const viewer = { tenantId: "tenant", userId: "platform-user", unionId: "union" };
    await f.service.listProjects(viewer);
    expect(f.repository.listVisible).toHaveBeenLastCalledWith(
      expect.objectContaining({
        member: { userId: "enterprise-1", departmentIds: ["11", "10", "1"] },
      }),
    );
    vi.mocked(f.directory.resolveMember).mockRejectedValue(new Error("expired permissions"));
    expect(await f.service.listProjects(viewer)).toMatchObject({ directoryUnavailable: true });
    expect(f.repository.listVisible).toHaveBeenLastCalledWith(
      expect.objectContaining({ member: null }),
    );
    await expect(f.service.getProject({ ...viewer, projectKey: "abc12" })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
  it("builds explicit detail whitelist and correctly encodes current file paths", async () => {
    const f = setup();
    vi.mocked(f.repository.findVisible).mockResolvedValue({
      projectKey: "abc12",
      displayName: "Demo",
      creatorDisplayName: "Owner",
      updatedAt: new Date(),
      fileCount: 1,
      totalSize: 3,
      homepagePath: null,
      files: [{ relativePath: "中文/空 格.html", size: 3 }],
    });
    const result = await f.service.getProject({
      tenantId: "tenant",
      userId: "owner",
      projectKey: "abc12",
    });
    expect(Object.keys(result.project).sort()).toEqual([
      "creatorDisplayName",
      "displayName",
      "fileCount",
      "homepage",
      "projectId",
      "totalSize",
      "updatedAt",
    ]);
    expect(result.files).toEqual([
      {
        relativePath: "中文/空 格.html",
        size: 3,
        url: "https://demo.example.com/abc12/%E4%B8%AD%E6%96%87/%E7%A9%BA%20%E6%A0%BC.html",
      },
    ]);
  });
});
