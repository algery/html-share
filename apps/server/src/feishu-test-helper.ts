import assert from "node:assert/strict";
import { afterEach, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createAuthSessionService,
  createMcpTokenService,
  InMemoryAuthRepository,
  InMemoryMcpTokenRepository,
} from "@html-share/core";
import { createSimulatorDingTalkClient } from "@html-share/dingtalk";
import { buildServerApp } from "./app.js";

const identity = {
  feishuAppId: "cli_test",
  feishuTenantKey: "org",
  feishuOpenId: "open-test",
  displayName: "测试成员",
  email: "member@example.com",
};
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
export function fixture(enabled = true) {
  const repository = new InMemoryAuthRepository();
  const sessions = createAuthSessionService({
    repository,
    stateSecret: "s".repeat(32),
    tenantAppKeyRef: "org-app",
  });
  const exchange = vi.fn<
    (input: {
      code: string;
      callbackUrl: string;
      codeVerifier?: string;
    }) => Promise<typeof identity>
  >(async () => identity);
  const app = buildServerApp({
    appAuthUrl: "http://app.localhost:3001",
    appHost: "app.localhost",
    appWebUrl: "http://app.localhost:3000",
    demoAuthUrl: "http://demo.localhost:3001",
    demoHost: "demo.localhost",
    demoWebUrl: "http://demo.localhost:3001",
    authSessions: sessions,
    dingtalk: createSimulatorDingTalkClient(),
    logger: false,
    ...(enabled
      ? {
          feishu: {
            stateSecret: "s".repeat(32),
            client: {
              createAuthorizationUrl(input: {
                callbackUrl: string;
                state: string;
                codeChallenge?: string;
              }) {
                const url = new URL("https://accounts.feishu.cn/authorize");
                url.searchParams.set("state", input.state);
                url.searchParams.set("redirect_uri", input.callbackUrl);
                url.searchParams.set("code_challenge", input.codeChallenge ?? "");
                return url.toString();
              },
              exchangeAuthorizationCode: exchange,
            },
          },
        }
      : {}),
    mcpTokens: createMcpTokenService({
      repository: new InMemoryMcpTokenRepository(),
      hashSecret: "t".repeat(32),
    }),
  });
  apps.push(app);
  return { app, exchange, repository, sessions };
}
export async function begin(app: FastifyInstance, host = "app.localhost", path = "/tokens") {
  const result = await app.inject({
    url: `/auth/feishu/login?return_path=${encodeURIComponent(path)}`,
    headers: { host },
  });
  expect(result.statusCode).toBe(302);
  const url = new URL(String(result.headers.location));
  const cookie = result.cookies.map((c) => `${c.name}=${encodeURIComponent(c.value)}`).join("; ");
  const state = url.searchParams.get("state");
  assert(state);
  return { state, cookie, url, cookieHeader: result.headers["set-cookie"] };
}
export function callback(state: string, code = "code-test") {
  return `/auth/feishu/callback?state=${state}&code=${code}`;
}
