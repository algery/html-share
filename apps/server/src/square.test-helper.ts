import { vi } from "vitest";
import type { ObjectStore } from "@html-share/storage";
import {
  createAuthSessionService,
  createMcpTokenService,
  createSquareService,
  emptySquareSettings,
  InMemoryAuthRepository,
  InMemoryMcpTokenRepository,
  type DirectoryGateway,
  type SquareRepository,
  type SquareStoredProject,
} from "@html-share/core";
import { createSimulatorDingTalkClient } from "@html-share/dingtalk";
import { buildServerApp } from "./app.js";

export const squareProject: SquareStoredProject = {
  projectKey: "abc12",
  displayName: "演示项目",
  creatorDisplayName: "创建者",
  updatedAt: new Date("2026-11-07T00:00:00Z"),
  fileCount: 1,
  totalSize: 3,
  homepagePath: null,
  files: [{ relativePath: "中文/页面 #.html", size: 3 }],
};
export function squareTestApp(storage?: ObjectStore) {
  const repository: SquareRepository = {
    findOwnedSettings: vi.fn().mockResolvedValue(emptySquareSettings()),
    saveOwnedSettings: vi.fn().mockImplementation(async ({ settings, expectedVersion }) => ({
      ...settings,
      settingsVersion: expectedVersion + 1,
    })),
    recordFailure: vi.fn().mockResolvedValue(undefined),
    listVisible: vi
      .fn()
      .mockResolvedValue({ projects: [squareProject], total: 1, page: 1, pageSize: 10 }),
    findVisible: vi.fn().mockResolvedValue(squareProject),
  };
  const directory: DirectoryGateway = {
    getSnapshot: vi.fn().mockResolvedValue({
      limited: true,
      departments: [
        { id: "10", name: "产品部", parentId: null, path: "产品部", hasChildren: true },
        { id: "11", name: "设计组", parentId: "10", path: "产品部 / 设计组", hasChildren: false },
      ],
      users: [
        { id: "staff1", name: "小王", departmentPaths: ["产品部"] },
        { id: "staff2", name: "小王", departmentPaths: ["产品部 / 设计组"] },
      ],
    }),
    resolveMember: vi.fn().mockResolvedValue({ userId: "staff1", departmentIds: ["10"] }),
  };
  const app = buildServerApp({
    appHost: "app.localhost",
    appAuthUrl: "http://app.localhost:3001",
    appWebUrl: "http://app.localhost:3000",
    demoHost: "demo.localhost",
    demoAuthUrl: "http://demo.localhost:3001",
    demoWebUrl: "http://demo.localhost:3001",
    authSessions: createAuthSessionService({
      repository: new InMemoryAuthRepository(),
      stateSecret: "square-test-state-secret-long-enough",
      tenantAppKeyRef: "square-test",
    }),
    dingtalk: createSimulatorDingTalkClient(),
    mcpTokens: createMcpTokenService({
      hashSecret: "square-test-token-secret-long-enough",
      repository: new InMemoryMcpTokenRepository(),
    }),
    square: createSquareService({
      repository,
      directory,
      demoWebUrl: "http://demo.localhost:3001",
    }),
    directory,
    ...(storage ? { storage } : {}),
    logger: false,
  });
  return { app, repository, directory };
}
