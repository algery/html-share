import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { Readable } from "node:stream";

import { expect, test, type BrowserContext } from "@playwright/test";
import type { FastifyInstance } from "fastify";

import {
  createAuthSessionService,
  createMcpTokenService,
  InMemoryAuthRepository,
  InMemoryMcpTokenRepository,
  type PasswordAccessService,
} from "../../packages/core/dist/index.js";
import { createSimulatorDingTalkClient } from "../../packages/dingtalk/dist/index.js";
import type { ObjectStore } from "../../packages/storage/dist/index.js";

import { buildServerApp } from "../../apps/server/dist/app.js";

const TENANT_ID = "browser-session-handoff-tenant";
const PASSWORD_PROJECT = "pwd12";
const ORGANIZATION_PROJECT = "org12";
const PROJECT_IDS = {
  [ORGANIZATION_PROJECT]: randomUUID(),
  [PASSWORD_PROJECT]: randomUUID(),
};
const HTML = "<!doctype html><title>Session handoff</title><h1>Demo content opened</h1>";
const FILE = {
  contentHash: "a".repeat(64),
  relativePath: "index.html",
  size: Buffer.byteLength(HTML),
  storageKey: "browser/session-handoff/index.html",
};

let app: FastifyInstance;
let appUrl: string;
let demoUrl: string;

test.beforeAll(async () => {
  const port = await reservePort();
  appUrl = `http://app.localhost:${port}`;
  demoUrl = `http://demo.localhost:${port}`;
  app = createApp(port);
  await app.listen({ host: "127.0.0.1", port });
});

test.afterAll(async () => {
  await app.close();
});

for (const [mode, projectKey] of [
  ["密码", PASSWORD_PROJECT],
  ["组织", ORGANIZATION_PROJECT],
] as const) {
  test(`只有管理端会话时直接打开${mode}访问 Demo`, async ({ browser }) => {
    const context = await browser.newContext();
    await createAppSession(context);
    const page = await context.newPage();
    const visited: string[] = [];
    const demoCookieHeaderReads: Promise<string>[] = [];
    page.on("request", (request) => {
      visited.push(request.url());
      if (request.url().startsWith(demoUrl))
        demoCookieHeaderReads.push(request.allHeaders().then((headers) => headers.cookie ?? ""));
    });

    await page.goto(`${demoUrl}/${projectKey}/index.html`, { waitUntil: "domcontentloaded" });

    await expect(page).toHaveURL(`${demoUrl}/${projectKey}/index.html`);
    await expect(page.getByRole("heading", { name: "Demo content opened" })).toBeVisible();
    expect(visited.some((url) => url.startsWith(`${appUrl}/auth/session-handoff/start?`))).toBe(
      true,
    );
    expect(visited.some((url) => url.startsWith(`${demoUrl}/auth/session-handoff/complete?`))).toBe(
      true,
    );
    expect(visited.some((url) => url.includes("/auth/password"))).toBe(false);
    expect(visited.some((url) => url.includes("/auth/content-login"))).toBe(false);
    const demoCookieHeaders = await Promise.all(demoCookieHeaderReads);
    expect(demoCookieHeaders.some((header) => header.includes("html_share_demo_session"))).toBe(
      true,
    );
    expect(demoCookieHeaders.every((header) => !header.includes("html_share_app_session"))).toBe(
      true,
    );
    const cookies = await context.cookies();
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domain: "app.localhost",
          httpOnly: true,
          name: "html_share_app_session",
          sameSite: "Lax",
        }),
        expect.objectContaining({
          domain: "demo.localhost",
          httpOnly: true,
          name: "html_share_demo_session",
          sameSite: "Lax",
        }),
      ]),
    );
    await context.close();
  });
}

test("管理端未登录时密码项目进入密码页", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${demoUrl}/${PASSWORD_PROJECT}/index.html`, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(
    `${demoUrl}/auth/password?return_path=${encodeURIComponent(`/${PASSWORD_PROJECT}/index.html`)}`,
  );
  await expect(page.getByText("此链接已开启密码访问")).toBeVisible();
  await context.close();
});

test("管理端未登录时组织项目进入钉钉授权而不显示密码页", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const visited: string[] = [];
  page.on("request", (request) => visited.push(request.url()));
  await page.goto(`${demoUrl}/${ORGANIZATION_PROJECT}/index.html`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page).toHaveURL(`${demoUrl}/${ORGANIZATION_PROJECT}/index.html`);
  await expect(page.getByRole("heading", { name: "Demo content opened" })).toBeVisible();
  expect(visited.some((url) => url.startsWith(`${demoUrl}/auth/content-login?`))).toBe(true);
  expect(visited.some((url) => url.includes("/auth/password"))).toBe(false);
  await context.close();
});

async function createAppSession(context: BrowserContext) {
  const started = await context.request.post(`${appUrl}/auth/internal/start`, {
    data: { returnPath: "/" },
    headers: { origin: appUrl },
  });
  expect(started.ok()).toBe(true);
  const body = (await started.json()) as { state: string };
  const completed = await context.request.post(`${appUrl}/auth/internal/complete`, {
    data: { code: "simulator-member", state: body.state },
    headers: { origin: appUrl },
  });
  expect(completed.ok()).toBe(true);
}

function createApp(port: number) {
  const passwordAccess: PasswordAccessService = {
    async authorize(input) {
      const target = await passwordAccess.getTarget(input);
      return target !== null && input.tenantId === TENANT_ID
        ? { file: FILE, principal: `organization:${TENANT_ID}` }
        : null;
    },
    async getTarget({ projectKey, relativePath }) {
      if (
        relativePath !== FILE.relativePath ||
        (projectKey !== PASSWORD_PROJECT && projectKey !== ORGANIZATION_PROJECT)
      )
        return null;
      return {
        accessMode: projectKey === PASSWORD_PROJECT ? "password" : "organization",
        passwordHash: projectKey === PASSWORD_PROJECT ? "opaque" : null,
        passwordVersion: 1,
        projectId: PROJECT_IDS[projectKey],
        projectKey,
        tenantId: TENANT_ID,
      };
    },
    async verifyPassword() {
      return null;
    },
  };
  const storage: ObjectStore = {
    async createPresignedUpload() {
      throw new Error("unused");
    },
    async deleteObjects() {
      return undefined;
    },
    async ensurePrivateBucket() {
      return undefined;
    },
    async getObject() {
      return Readable.from([HTML]);
    },
    async headObject() {
      return {
        contentMd5: "AAAAAAAAAAAAAAAAAAAAAA==",
        contentType: "text/html; charset=utf-8",
        size: FILE.size,
      };
    },
    async listObjects() {
      return { keys: [] };
    },
  };
  return buildServerApp({
    appAuthUrl: `http://app.localhost:${port}`,
    appHost: "app.localhost",
    appWebUrl: `http://app.localhost:${port}`,
    authSessions: createAuthSessionService({
      repository: new InMemoryAuthRepository(),
      stateSecret: "browser-session-handoff-state-secret-with-enough-length",
      tenantAppKeyRef: TENANT_ID,
    }),
    demoAuthUrl: `http://demo.localhost:${port}`,
    demoHost: "demo.localhost",
    demoWebUrl: `http://demo.localhost:${port}`,
    dingtalk: createSimulatorDingTalkClient(),
    logger: false,
    mcpTokens: createMcpTokenService({
      hashSecret: "browser-session-handoff-token-secret-with-enough-length",
      repository: new InMemoryMcpTokenRepository(),
    }),
    passwordAccess,
    passwordStateSecret: "browser-password-state-secret-with-enough-length",
    storage,
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No test port assigned");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}
