import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PasswordAccessService, PasswordAccessTarget } from "@html-share/core";

import { registerPasswordRoutes, type PasswordRouteOptions } from "./password-routes.js";
import { passwordAccessCookieName, usesSecurePasswordCookie } from "./password-cookies.js";

const PATH = "/abc12/%E4%B8%AD%E6%96%87/a%20b.html?preview=1&value=%25";
const NOW = new Date("2026-09-09T10:00:00Z");
const HEADERS = { host: "demo.test", origin: "https://demo.test", "x-forwarded-proto": "https" };
const TARGET: PasswordAccessTarget = {
  projectId: "11111111-1111-4111-8111-111111111111",
  tenantId: "tenant-1",
  projectKey: "abc12",
  accessMode: "password",
  passwordVersion: 1,
  passwordHash: "private-hash-never-returned",
};
const applications: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

function setup(extra: Partial<PasswordRouteOptions> = {}) {
  const demoHost = extra.demoHost ?? "demo.test";
  const demoWebUrl = extra.demoWebUrl ?? "https://demo.test";
  const requestHeaders = {
    host: demoHost,
    origin: new URL(demoWebUrl).origin,
    "x-forwarded-proto": new URL(demoWebUrl).protocol.slice(0, -1),
  };
  const getTarget = vi.fn<PasswordAccessService["getTarget"]>().mockResolvedValue({ ...TARGET });
  const verifyPassword = vi.fn<PasswordAccessService["verifyPassword"]>().mockResolvedValue(null);
  const app = Fastify({ logger: false, trustProxy: true });
  app.register(cookie);
  registerPasswordRoutes(app, {
    demoHost,
    demoWebUrl,
    now: () => NOW,
    stateSecret: "password-route-test-secret-at-least-32-characters",
    passwordAccess: { getTarget, verifyPassword, authorize: async () => null },
    ...extra,
  });
  applications.push(app);
  const open = async (path = PATH) => {
    const page = await app.inject({
      url: `/auth/password?${new URLSearchParams({ return_path: path })}`,
      headers: requestHeaders,
    });
    const state = page.body.match(/"state":"([A-Za-z0-9_.-]+)"/)?.[1] ?? "";
    const cookieHeader = page.headers["set-cookie"];
    const browserCookie =
      (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)?.split(";")[0] ?? "";
    return { page, state, browserCookie };
  };
  const verify = (state: string, browserCookie: string, password = "Abcd2345", extraHeaders = {}) =>
    app.inject({
      method: "POST",
      url: "/auth/password/verify",
      headers: { ...requestHeaders, cookie: browserCookie, ...extraHeaders },
      payload: { state, password },
    });
  return { app, getTarget, verifyPassword, open, verify };
}

describe("password page and verification", () => {
  it("rejects insecure password access on non-local hosts", () => {
    expect(() => usesSecurePasswordCookie("http://demo.example.com")).toThrow(
      "Password access requires HTTPS",
    );
    expect(usesSecurePasswordCookie("https://demo.example.com")).toBe(true);
    expect(usesSecurePasswordCookie("http://demo.localhost:3001")).toBe(false);
    expect(usesSecurePasswordCookie("http://127.0.0.1:3001")).toBe(false);
    expect(usesSecurePasswordCookie("http://127.0.0.2:3001")).toBe(false);
  });

  it("does not render a password form over plaintext HTTP", async () => {
    const { app } = setup();
    const result = await app.inject({
      url: `/auth/password?return_path=${encodeURIComponent(PATH)}`,
      headers: { ...HEADERS, "x-forwarded-proto": "http" },
    });
    expect(result.statusCode).toBe(403);
    expect(result.body).not.toContain("password-form");
  });

  it("supports local HTTP with separate non-secure development cookies", async () => {
    const { open, verify, verifyPassword } = setup({
      demoHost: "demo.localhost",
      demoWebUrl: "http://demo.localhost:3001",
    });
    const { page, state, browserCookie } = await open();
    expect(page.statusCode).toBe(200);
    expect(browserCookie).toMatch(/^html_share_password_browser=/);
    expect(page.headers["set-cookie"]).not.toContain("__Host-");
    expect(page.headers["set-cookie"]).not.toContain("Secure");
    expect(page.headers["set-cookie"]).toContain("HttpOnly");
    verifyPassword.mockResolvedValue({
      token: "a".repeat(43),
      expiresAt: new Date(NOW.getTime() + 28_800_000),
      projectId: TARGET.projectId,
      projectKey: "abc12",
    });
    const verified = await verify(state, browserCookie);
    expect(verified.statusCode).toBe(200);
    expect(verified.headers["set-cookie"]).toContain("html_share_password_abc12=");
    expect(verified.headers["set-cookie"]).not.toContain("__Host-");
    expect(verified.headers["set-cookie"]).not.toContain("Secure");
  });
  it("renders a private, nonce-protected form with an explicit DingTalk action and no automatic login", async () => {
    const { open, getTarget } = setup();
    const { page, state, browserCookie } = await open();
    expect(page.statusCode).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.headers["content-security-policy"]).toContain("script-src 'nonce-");
    expect(page.body).toContain("此链接已开启密码访问");
    expect(page.body).toContain('<label for="password">访问密码</label>');
    expect(page.body).toContain('name="viewport"');
    expect(page.body).toContain("password_return=");
    expect(page.body).not.toMatch(/window\.dd|requestAuthCode|private-hash|passwordHash/);
    expect(state).not.toBe("");
    expect(browserCookie).toMatch(/^__Host-html_share_password_browser=/);
    expect(page.headers["set-cookie"]).toContain("Secure");
    expect(page.headers["set-cookie"]).toContain("HttpOnly");
    expect(page.headers["set-cookie"]).not.toContain("Domain=");
    expect(getTarget).toHaveBeenCalledWith({ projectKey: "abc12", relativePath: "中文/a b.html" });
  });

  it("sets a project-specific protected cookie and redirects to the exact path after trimming only edges", async () => {
    const { open, verify, verifyPassword } = setup();
    const { state, browserCookie } = await open();
    verifyPassword.mockResolvedValue({
      token: "a".repeat(43),
      expiresAt: new Date(NOW.getTime() + 28_800_000),
      projectId: TARGET.projectId,
      projectKey: "abc12",
    });
    const result = await verify(state, browserCookie, "  Abcd2345 \t");
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ redirectUrl: PATH });
    expect(verifyPassword).toHaveBeenCalledWith({
      projectKey: "abc12",
      relativePath: "中文/a b.html",
      password: "Abcd2345",
    });
    const grantCookie = result.headers["set-cookie"];
    expect(grantCookie).toContain("__Host-html_share_password_abc12=");
    for (const attribute of ["Max-Age=28800", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"])
      expect(grantCookie).toContain(attribute);
    expect(grantCookie).not.toContain("Domain=");
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(passwordAccessCookieName("abc12")).not.toBe(passwordAccessCookieName("xyz34"));
  });

  it("rejects missing, tampered and other-browser states before password work", async () => {
    const { open, verify, verifyPassword } = setup();
    const first = await open();
    const second = await open();
    for (const [state, browserCookie] of [
      [first.state, ""],
      [first.state, second.browserCookie],
      [`${first.state}x`, first.browserCookie],
      ["", first.browserCookie],
    ]) {
      const result = await verify(state ?? "", browserCookie ?? "");
      expect(result.statusCode).toBe(400);
      expect(result.body).not.toContain("Abcd2345");
    }
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("requires exact Origin and HTTPS before parsing password attempts", async () => {
    const { open, verify, verifyPassword } = setup();
    const { state, browserCookie } = await open();
    for (const headers of [
      { origin: "https://evil.test" },
      { origin: "null" },
      { origin: "" },
      { "x-forwarded-proto": "http" },
    ])
      expect((await verify(state, browserCookie, "Abcd2345", headers)).statusCode).toBe(403);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("supports empty, wrong and retry states, and never returns secret metadata", async () => {
    const { open, verify, verifyPassword } = setup();
    const { state, browserCookie } = await open();
    expect((await verify(state, browserCookie, "  ")).json()).toEqual({ error: "请输入访问密码" });
    const wrong = await verify(state, browserCookie);
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: "密码错误，请重试" });
    expect((await verify(state, browserCookie)).statusCode).toBe(401);
    expect(verifyPassword).toHaveBeenCalledTimes(2);
    expect(wrong.headers.etag).toBeUndefined();
    expect(wrong.body).not.toContain(TARGET.passwordHash);
  });

  it("rechecks deleted files, disabled modes and UUID reuse before accepting a password", async () => {
    const { open, verify, getTarget, verifyPassword } = setup();
    const { state, browserCookie } = await open();
    getTarget.mockResolvedValue(null);
    expect((await verify(state, browserCookie)).statusCode).toBe(404);
    expect((await open()).page.statusCode).toBe(404);
    getTarget.mockResolvedValue({ ...TARGET, projectId: "22222222-2222-4222-8222-222222222222" });
    expect((await verify(state, browserCookie)).statusCode).toBe(404);
    getTarget.mockResolvedValue({ ...TARGET, accessMode: "organization" });
    const disabled = await verify(state, browserCookie);
    expect(disabled.json<{ redirectUrl: string }>().redirectUrl).toContain("/auth/content-login?");
    expect((await open()).page.statusCode).toBe(302);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("returns 404 when deletion wins a verification race", async () => {
    const { open, verify, getTarget, verifyPassword } = setup();
    const { state, browserCookie } = await open();
    verifyPassword.mockImplementation(async () => {
      getTarget.mockResolvedValue(null);
      return null;
    });
    expect((await verify(state, browserCookie)).statusCode).toBe(404);
  });

  it("maps hash capacity to retryable 429 and sanitizes unexpected errors and malformed JSON", async () => {
    const { app, open, verify, verifyPassword } = setup();
    const { state, browserCookie } = await open();
    verifyPassword.mockRejectedValue(new Error("Password hashing capacity exceeded"));
    const busy = await verify(state, browserCookie);
    expect(busy.statusCode).toBe(429);
    expect(busy.headers["retry-after"]).toBe("5");
    verifyPassword.mockRejectedValue(new Error("Abcd2345 private data"));
    const failure = await verify(state, browserCookie);
    expect(failure.statusCode).toBe(503);
    expect(failure.body).not.toContain("Abcd2345");
    const malformed = await app.inject({
      method: "POST",
      url: "/auth/password/verify",
      headers: { ...HEADERS, "content-type": "application/json" },
      payload: '{"password":"Abcd2345"',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain("Abcd2345");
    expect(malformed.headers["cache-control"]).toBe("no-store");
  });

  it.each([
    { ipPerMinute: 1, ipProjectPerMinute: 30, projectPerMinute: 120 },
    { ipPerMinute: 60, ipProjectPerMinute: 1, projectPerMinute: 120 },
    { ipPerMinute: 60, ipProjectPerMinute: 30, projectPerMinute: 1 },
  ])("enforces a separate rate dimension before hashing: %j", async (rateLimits) => {
    const { open, verify, verifyPassword } = setup({ rateLimits });
    const { state, browserCookie } = await open();
    expect((await verify(state, browserCookie)).statusCode).toBe(401);
    const limited = await verify(state, browserCookie);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(verifyPassword).toHaveBeenCalledTimes(1);
    expect((await open()).page.body).toContain("钉钉登录打开");
  });

  it("allows 20 first attempts from a shared office IP under defaults", async () => {
    const { open, verify, verifyPassword } = setup();
    const visitors = await Promise.all(Array.from({ length: 20 }, () => open()));
    const results = await Promise.all(
      visitors.map(({ state, browserCookie }) => verify(state, browserCookie)),
    );
    expect(results.every((result) => result.statusCode === 401)).toBe(true);
    expect(verifyPassword).toHaveBeenCalledTimes(20);
  });

  it("redirects authorized visitors and rejects invalid routes without discovering a project", async () => {
    const { open, getTarget } = setup({ isAuthorized: async () => true });
    expect((await open()).page.headers.location).toBe(PATH);
    getTarget.mockClear();
    for (const path of ["//evil.test/a", "/abc12/%2e%2e/a", "/abc12/"])
      expect((await open(path)).page.statusCode).toBe(404);
    expect(getTarget).not.toHaveBeenCalled();
  });
});
