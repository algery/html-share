import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { vi } from "vitest";
import {
  createAuthSessionService,
  createMcpTokenService,
  InMemoryAuthRepository,
  InMemoryMcpTokenRepository,
  type AuthRepository,
  type PasswordAccessService,
} from "@html-share/core";
import { createSimulatorDingTalkClient } from "@html-share/dingtalk";
import type { ObjectStore } from "@html-share/storage";
import { buildServerApp } from "./app.js";

export const RETURN_PATH = "/abc12/nested/%E6%B5%8B%E8%AF%95%20file.html?preview=a%20b";
export const FILE = {
  contentHash: "a".repeat(64),
  relativePath: "nested/测试 file.html",
  size: 17,
  storageKey: "isolated/content",
};
export const DEMO_HEADERS = { host: "demo.localhost", "x-forwarded-proto": "https" };
export function cookies(response: { headers: Record<string, unknown> }) {
  const values = response.headers["set-cookie"];
  return (Array.isArray(values) ? values : typeof values === "string" ? [values] : [])
    .map((value: string) => value.split(";", 1)[0])
    .join("; ");
}
export function pageState(page: string) {
  const state = page.match(/"state":"([^"]+)"/)?.[1];
  if (!state) throw new Error("Missing page state");
  return state;
}
export function passwordFixture(
  options: { authRepository?: AuthRepository; localHttp?: boolean } = {},
) {
  const demoWebUrl = options.localHttp ? "http://demo.localhost:3001" : "https://demo.localhost";
  const demoHeaders = options.localHttp
    ? { host: "demo.localhost", "x-forwarded-proto": "http" }
    : DEMO_HEADERS;
  const target = {
    projectId: randomUUID(),
    tenantId: "test-dingtalk-app",
    projectKey: "abc12",
    accessMode: "password" as "password" | "organization",
    passwordVersion: 1,
    passwordHash: "opaque",
  };
  const token = randomBytes(32).toString("base64url");
  let active = true;
  let fileExists = true;
  let grantValid = true;
  const service: PasswordAccessService = {
    getTarget: vi.fn(async ({ projectKey, relativePath }) =>
      active &&
      fileExists &&
      projectKey === "abc12" &&
      [FILE.relativePath, "style.css"].includes(relativePath)
        ? target
        : null,
    ),
    verifyPassword: vi.fn(async ({ password }) =>
      password === "Sample8A"
        ? {
            token,
            projectId: target.projectId,
            projectKey: target.projectKey,
            expiresAt: new Date(Date.now() + 8 * 3600_000),
          }
        : null,
    ),
    authorize: vi.fn(async (input) => {
      if ((await service.getTarget(input)) === null) return null;
      if (input.tenantId === target.tenantId)
        return { file: FILE, principal: "organization:tenant" };
      return target.accessMode === "password" && grantValid && input.token === token
        ? { file: FILE, principal: "password:grant-id" }
        : null;
    }),
  };
  const storage: ObjectStore = {
    createPresignedUpload: vi.fn(async () => {
      throw new Error("unused");
    }),
    deleteObjects: vi.fn(async () => undefined),
    ensurePrivateBucket: vi.fn(async () => undefined),
    getObject: vi.fn(async () => Readable.from(["protected-content"])),
    headObject: vi.fn(async () => ({
      contentMd5: "AAAAAAAAAAAAAAAAAAAAAA==",
      contentType: "text/html",
      size: FILE.size,
    })),
    listObjects: vi.fn(async () => ({ keys: [] })),
  };
  const authSessions = createAuthSessionService({
    repository: options.authRepository ?? new InMemoryAuthRepository(),
    stateSecret: "isolated-password-routing-state-secret-32-chars",
    tenantAppKeyRef: target.tenantId,
  });
  const app = buildServerApp({
    appHost: "app.localhost",
    appAuthUrl: "https://app.localhost",
    appWebUrl: "https://app.localhost",
    demoHost: "demo.localhost",
    demoAuthUrl: "https://demo.localhost",
    demoWebUrl,
    logger: false,
    trustProxy: true,
    dingtalk: createSimulatorDingTalkClient(),
    authSessions,
    passwordAccess: service,
    passwordStateSecret: "isolated-password-routing-state-secret-32-chars",
    mcpTokens: createMcpTokenService({
      repository: new InMemoryMcpTokenRepository(),
      hashSecret: "isolated-password-routing-token-secret-32-chars",
    }),
    storage,
  });
  return {
    app,
    authSessions,
    demoHeaders,
    service,
    target,
    storage,
    token,
    removeFile() {
      fileExists = false;
    },
    setActive(value: boolean) {
      active = value;
    },
    revoke() {
      grantValid = false;
    },
    async organizationCookie(audience: "demo" | "app" = "demo") {
      const state = await authSessions.beginAuthorization({ audience, returnPath: RETURN_PATH });
      const auth = await authSessions.finishAuthorization({
        audience,
        state: state.state,
        identity: { dingtalkUserId: "member", displayName: "Member" },
      });
      return `html_share_${audience}_session=${auth.token}`;
    },
    async passwordPage() {
      return app.inject({
        url: `/auth/password?return_path=${encodeURIComponent(RETURN_PATH)}`,
        headers: demoHeaders,
      });
    },
  };
}
