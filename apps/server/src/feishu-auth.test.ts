import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AccountLinkError } from "@html-share/core";
import { FeishuAuthorizationError } from "./modules/auth/feishu-client.js";
import { begin, callback, fixture } from "./feishu-test-helper.js";

describe("Feishu organization authorization", () => {
  it("keeps default configuration DingTalk-only and hides credentials", async () => {
    const { app } = fixture(false);
    const config = await app.inject({
      url: "/auth/config",
      headers: { host: "app.localhost", origin: "http://app.localhost:3000" },
    });
    expect(config.json()).toEqual({ dingtalk: true, feishu: false });
    expect(config.headers["access-control-allow-origin"]).toBe("http://app.localhost:3000");
    expect(config.headers["cache-control"]).toBe("no-store");
    expect(
      (await app.inject({ url: "/auth/feishu/login", headers: { host: "app.localhost" } }))
        .statusCode,
    ).toBe(404);
  });

  it("binds browser state and PKCE, reuses a DingTalk user, and issues an 8-hour app session", async () => {
    const { app, repository, sessions, exchange } = fixture();
    const user = await repository.upsertUser({
      tenantAppKeyRef: "org-app",
      dingtalkUserId: "original",
      displayName: "原成员",
      email: "MEMBER@example.com",
      now: new Date(),
    });
    const start = await begin(app);
    expect(start.cookieHeader).toContain("HttpOnly");
    expect(start.cookieHeader).toContain("SameSite=Lax");
    const response = await app.inject({
      url: callback(start.state),
      headers: { host: "app.localhost", cookie: start.cookie },
    });
    expect(response.headers.location).toBe("http://app.localhost:3000/tokens");
    const input = exchange.mock.calls[0]?.[0];
    assert(input?.codeVerifier);
    expect(input.callbackUrl).toBe("http://app.localhost:3001/auth/feishu/callback");
    expect(createHash("sha256").update(input.codeVerifier).digest("base64url")).toBe(
      start.url.searchParams.get("code_challenge"),
    );
    const sessionCookie = response.cookies.find((c) => c.name.includes("app_session"));
    assert(sessionCookie);
    const session = await sessions.getSession({ audience: "app", token: sessionCookie.value });
    expect(session?.user.id).toBe(user.id);
    expect(session?.user.dingtalkUserId).toBe("original");
    assert(session);
    expect(session.expiresAt.getTime() - Date.now()).toBeGreaterThan(8 * 3600000 - 10000);
    expect(await sessions.getSession({ audience: "demo", token: sessionCookie.value })).toBeNull();
    const replay = await app.inject({
      url: callback(start.state),
      headers: { host: "app.localhost", cookie: start.cookie },
    });
    expect(replay.headers.location).toBe("http://app.localhost:3000/login?status=error");
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("rejects missing, forged, cross-browser and cross-audience state before any provider request", async () => {
    const { app, exchange } = fixture();
    const a = await begin(app);
    const b = await begin(app);
    for (const headers of [
      { host: "app.localhost" },
      { host: "app.localhost", cookie: b.cookie },
      { host: "demo.localhost", cookie: a.cookie },
      { host: "app.localhost", cookie: a.cookie.replace(/.$/, "X") },
    ]) {
      const response = await app.inject({ url: callback(a.state), headers });
      expect(response.statusCode).toBe(302);
      expect(String(response.headers.location)).not.toMatch(/code=|state=/);
      expect(response.cookies.some((c) => c.name.includes("session") && c.value)).toBe(false);
    }
    expect(exchange).not.toHaveBeenCalled();
  });

  it("does not let a DingTalk state complete Feishu, even with copied browser cookie", async () => {
    const { app, sessions, exchange } = fixture();
    const ding = await sessions.beginAuthorization({ audience: "app", returnPath: "/" });
    const start = await begin(app);
    await app.inject({
      url: callback(ding.state),
      headers: { host: "app.localhost", cookie: start.cookie },
    });
    expect(exchange).not.toHaveBeenCalled();
  });

  it.each(["//evil.example", "/\\evil.example", "/\n/evil.example", "/\t/evil.example"])(
    "rejects unsafe return %j",
    async (path) => {
      const { app, exchange } = fixture();
      const result = await app.inject({
        url: `/auth/feishu/login?return_path=${encodeURIComponent(path)}`,
        headers: { host: "app.localhost" },
      });
      expect(result.statusCode).toBe(400);
      expect(exchange).not.toHaveBeenCalled();
    },
  );

  it("offers both content providers and preserves the exact file path through Feishu", async () => {
    const { app, sessions } = fixture();
    const path = "/abc12/a.html?preview=1";
    const page = await app.inject({
      url: `/auth/content-login?return_path=${encodeURIComponent(path)}`,
      headers: { host: "demo.localhost" },
    });
    expect(page.body).toContain("飞书登录打开");
    expect(page.body).toContain("provider=dingtalk");
    const start = await begin(app, "demo.localhost", path);
    const done = await app.inject({
      url: callback(start.state),
      headers: { host: "demo.localhost", cookie: start.cookie },
    });
    expect(done.headers.location).toBe(`http://demo.localhost:3001${path}`);
    const token = done.cookies.find((c) => c.name.includes("demo_session"))?.value;
    expect(
      (await sessions.getSession({ audience: "demo", token }))?.user.dingtalkUserId,
    ).toBeNull();
  });

  it.each([
    [new FeishuAuthorizationError("PROVIDER_UNAVAILABLE"), "error"],
    [new FeishuAuthorizationError("AUTHORIZATION_DENIED"), "denied"],
    [new AccountLinkError("ACCOUNT_LINK_CONFLICT"), "account-conflict"],
    [new AccountLinkError("ACCOUNT_DISABLED"), "denied"],
  ])("fails closed and removes credentials from the callback URL", async (error, status) => {
    const { app, exchange } = fixture();
    exchange.mockRejectedValueOnce(error);
    const start = await begin(app);
    const response = await app.inject({
      url: callback(start.state),
      headers: { host: "app.localhost", cookie: start.cookie },
    });
    expect(response.headers.location).toBe(`http://app.localhost:3000/login?status=${status}`);
    expect(response.cookies.some((c) => c.name.includes("session") && c.value)).toBe(false);
    await app.inject({
      url: callback(start.state),
      headers: { host: "app.localhost", cookie: start.cookie },
    });
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("keeps long encoded file paths in server state and uses a bounded browser cookie", async () => {
    const { app } = fixture();
    const path =
      "/abc12/" +
      Array(4)
        .fill(encodeURIComponent("文".repeat(60)))
        .join("/") +
      "/index.html?preview=1";
    expect(path.length).toBeGreaterThan(2048);
    const start = await begin(app, "demo.localhost", path);
    expect(start.cookie.length).toBeLessThan(1024);
    const response = await app.inject({
      url: callback(start.state),
      headers: { host: "demo.localhost", cookie: start.cookie },
    });
    expect(response.headers.location).toBe(`http://demo.localhost:3001${path}`);
    const retry = await begin(app, "demo.localhost", path);
    const cancelled = await app.inject({
      url: `/auth/feishu/callback?state=${retry.state}&error=access_denied`,
      headers: { host: "demo.localhost", cookie: retry.cookie },
    });
    expect(new URL(String(cancelled.headers.location)).searchParams.get("return_path")).toBe(path);
  });

  it("consumes cancelled authorization and allows starting over", async () => {
    const { app, exchange } = fixture();
    const start = await begin(app);
    const cancelled = await app.inject({
      url: `/auth/feishu/callback?state=${start.state}&error=access_denied`,
      headers: { host: "app.localhost", cookie: start.cookie },
    });
    expect(cancelled.headers.location).toBe("http://app.localhost:3000/login?status=denied");
    await app.inject({
      url: callback(start.state),
      headers: { host: "app.localhost", cookie: start.cookie },
    });
    expect(exchange).not.toHaveBeenCalled();
    await begin(app);
  });
  it("cleans rate-limited callbacks without issuing a session", async () => {
    const { app, exchange } = fixture();
    const start = await begin(app);
    for (let i = 0; i < 29; i++)
      await app.inject({ url: "/auth/feishu/login", headers: { host: "app.localhost" } });
    const response = await app.inject({
      url: callback(start.state),
      headers: { host: "app.localhost", cookie: start.cookie },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("http://app.localhost:3000/login?status=error");
    expect(response.cookies[0]?.value).toBe("");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("shows a DingTalk account conflict without issuing a session", async () => {
    const { app, repository } = fixture();
    vi.spyOn(repository, "upsertUser").mockRejectedValueOnce(
      new AccountLinkError("ACCOUNT_LINK_CONFLICT"),
    );
    const start = await app.inject({ url: "/auth/login", headers: { host: "app.localhost" } });
    const target = new URL(String(start.headers.location));
    const result = await app.inject({
      url: target.pathname + target.search,
      headers: { host: "app.localhost" },
    });
    expect(result.headers.location).toBe("http://app.localhost:3000/login?status=account-conflict");
    expect(result.cookies.some((c) => c.name.includes("session") && c.value)).toBe(false);
  });
});
