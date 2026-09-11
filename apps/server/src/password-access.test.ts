import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cookies,
  DEMO_HEADERS,
  FILE,
  pageState,
  passwordFixture,
  RETURN_PATH,
} from "./password-access.test-helper.js";
import { InMemoryAuthRepository } from "@html-share/core";

const fixtures: ReturnType<typeof passwordFixture>[] = [];
function fixture() {
  const value = passwordFixture();
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(({ app }) => app.close()));
});

describe("password content gateway integration", () => {
  it.each(["GET", "HEAD"] as const)(
    "unauthorized %s and conditional requests redirect before object metadata",
    async (method) => {
      const { app, storage } = fixture();
      for (const userAgent of ["browser", "DingTalk iPhone"]) {
        const first = await app.inject({
          method,
          url: RETURN_PATH,
          headers: {
            ...DEMO_HEADERS,
            "user-agent": userAgent,
            "if-none-match": `"${FILE.contentHash}"`,
          },
        });
        expect(first.statusCode).toBe(302);
        expect(first.headers.location).toBe(
          `https://app.localhost/auth/session-handoff/start?return_path=${encodeURIComponent(RETURN_PATH)}`,
        );
        const start = new URL(String(first.headers.location));
        const anonymous = await app.inject({
          url: `${start.pathname}${start.search}`,
          headers: { host: "app.localhost" },
        });
        const complete = new URL(String(anonymous.headers.location));
        const checked = await app.inject({
          url: `${complete.pathname}${complete.search}`,
          headers: DEMO_HEADERS,
        });
        expect(checked.headers["set-cookie"]).toContain(
          "html_share_demo_session_handoff_checked=1",
        );
        expect(checked.headers["set-cookie"]).toContain("Max-Age=60");
        expect(checked.headers["set-cookie"]).toContain("HttpOnly");
        expect(checked.headers["set-cookie"]).toContain("Secure");
        expect(checked.headers["set-cookie"]).toContain("SameSite=Lax");
        expect(checked.headers["set-cookie"]).not.toContain("Domain=");
        const response = await app.inject({
          method,
          url: RETURN_PATH,
          headers: {
            ...DEMO_HEADERS,
            cookie: cookies(checked),
            "user-agent": userAgent,
            "if-none-match": `"${FILE.contentHash}"`,
          },
        });
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe(
          `/auth/password?return_path=${encodeURIComponent(RETURN_PATH)}`,
        );
        expect(response.body).toBe("");
        expect(response.headers.etag).toBeUndefined();
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["set-cookie"]).toContain("Max-Age=0");
      }
      expect(storage.headObject).not.toHaveBeenCalled();
      expect(storage.getObject).not.toHaveBeenCalled();
    },
  );

  it("opens exact files and resources after password POST, then rejects revoked grants before 304", async () => {
    const f = fixture();
    const page = await f.passwordPage();
    expect(page.body).toContain("此链接已开启密码访问");
    expect(page.body).not.toContain("requestAuthCode");
    const verified = await f.app.inject({
      method: "POST",
      url: "/auth/password/verify",
      headers: { ...DEMO_HEADERS, origin: "https://demo.localhost", cookie: cookies(page) },
      payload: { state: pageState(page.body), password: "Sample8A" },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toEqual({ redirectUrl: RETURN_PATH });
    const cookie = cookies(verified);
    for (const url of [RETURN_PATH, "/abc12/style.css"]) {
      const response = await f.app.inject({ url, headers: { ...DEMO_HEADERS, cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("protected-content");
      expect(response.headers["cache-control"]).toBe("private, max-age=0, must-revalidate");
    }
    const headers = { ...DEMO_HEADERS, cookie, "if-none-match": `"${FILE.contentHash}"` };
    expect((await f.app.inject({ url: RETURN_PATH, headers })).statusCode).toBe(304);
    f.revoke();
    const calls = vi.mocked(f.storage.headObject).mock.calls;
    const before = calls?.length;
    expect((await f.app.inject({ method: "HEAD", url: RETURN_PATH, headers })).statusCode).toBe(
      302,
    );
    expect(calls?.length).toBe(before);
    expect((await f.app.inject({ url: "/xyz98/a.html", headers })).statusCode).toBe(404);
    for (const url of ["/api/projects", "/mcp"]) {
      expect((await f.app.inject({ url, headers })).statusCode).toBe(404);
    }
  });

  it("uses the local HTTP grant cookie for subsequent content requests", async () => {
    const f = passwordFixture({ localHttp: true });
    fixtures.push(f);
    const page = await f.passwordPage();
    expect(page.statusCode).toBe(200);
    const verified = await f.app.inject({
      method: "POST",
      url: "/auth/password/verify",
      headers: {
        ...f.demoHeaders,
        origin: "http://demo.localhost:3001",
        cookie: cookies(page),
      },
      payload: { state: pageState(page.body), password: "Sample8A" },
    });
    expect(verified.statusCode).toBe(200);
    const cookie = cookies(verified);
    expect(cookie).toContain("html_share_password_abc12=");
    expect(cookie).not.toContain("__Host-");
    expect(
      (
        await f.app.inject({
          url: RETURN_PATH,
          headers: { ...f.demoHeaders, cookie },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("opens with a demo session and securely hands an app session to the demo host", async () => {
    const f = fixture();
    const cookie = await f.organizationCookie();
    expect(
      (await f.app.inject({ url: RETURN_PATH, headers: { ...DEMO_HEADERS, cookie } })).statusCode,
    ).toBe(200);
    const page = await f.app.inject({
      url: `/auth/password?return_path=${encodeURIComponent(RETURN_PATH)}`,
      headers: { ...DEMO_HEADERS, cookie },
    });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe(RETURN_PATH);
    const appCookie = await f.organizationCookie("app");
    const directAppCookie = await f.app.inject({
      url: RETURN_PATH,
      headers: { ...DEMO_HEADERS, cookie: appCookie },
    });
    expect(directAppCookie.headers.location).toContain("/auth/session-handoff/start?");
    const start = new URL(String(directAppCookie.headers.location));
    const issued = await f.app.inject({
      url: `${start.pathname}${start.search}`,
      headers: { host: "app.localhost", cookie: appCookie },
    });
    const complete = new URL(String(issued.headers.location));
    expect(complete.searchParams.get("ticket")).not.toBeNull();
    expect(complete.searchParams.get("return_path")).toBeNull();
    const handed = await f.app.inject({
      url: `${complete.pathname}${complete.search}`,
      headers: DEMO_HEADERS,
    });
    expect(handed.statusCode).toBe(302);
    expect(handed.headers.location).toBe(`https://demo.localhost${RETURN_PATH}`);
    const demoCookie = cookies(handed);
    expect(demoCookie).toContain("html_share_demo_session=");
    expect(demoCookie).not.toContain("Domain=");
    expect(
      (
        await f.app.inject({
          url: RETURN_PATH,
          headers: { ...DEMO_HEADERS, cookie: demoCookie },
        })
      ).statusCode,
    ).toBe(200);
    f.target.accessMode = "organization";
    const organizationWithApp = await f.app.inject({
      url: RETURN_PATH,
      headers: { ...DEMO_HEADERS, cookie: appCookie },
    });
    const organizationAppStart = new URL(String(organizationWithApp.headers.location));
    const organizationIssued = await f.app.inject({
      url: `${organizationAppStart.pathname}${organizationAppStart.search}`,
      headers: { host: "app.localhost", cookie: appCookie },
    });
    const organizationAppComplete = new URL(String(organizationIssued.headers.location));
    const organizationHanded = await f.app.inject({
      url: `${organizationAppComplete.pathname}${organizationAppComplete.search}`,
      headers: DEMO_HEADERS,
    });
    expect(
      (
        await f.app.inject({
          url: RETURN_PATH,
          headers: { ...DEMO_HEADERS, cookie: cookies(organizationHanded) },
        })
      ).statusCode,
    ).toBe(200);
    const organizationFirst = await f.app.inject({ url: RETURN_PATH, headers: DEMO_HEADERS });
    const organizationStart = new URL(String(organizationFirst.headers.location));
    const organizationAnonymous = await f.app.inject({
      url: `${organizationStart.pathname}${organizationStart.search}`,
      headers: { host: "app.localhost" },
    });
    const organizationComplete = new URL(String(organizationAnonymous.headers.location));
    const organizationChecked = await f.app.inject({
      url: `${organizationComplete.pathname}${organizationComplete.search}`,
      headers: DEMO_HEADERS,
    });
    expect(
      (
        await f.app.inject({
          url: RETURN_PATH,
          headers: { ...DEMO_HEADERS, cookie: cookies(organizationChecked) },
        })
      ).headers.location,
    ).toContain("/auth/content-login?");
    f.setActive(false);
    expect(
      (await f.app.inject({ url: RETURN_PATH, headers: { ...DEMO_HEADERS, cookie } })).statusCode,
    ).toBe(404);
  });

  it("rejects unsafe, tampered, replayed, and cross-host session handoffs", async () => {
    const f = fixture();
    expect(
      (
        await f.app.inject({
          url: "/auth/session-handoff/start?return_path=https%3A%2F%2Fattacker.test",
          headers: { host: "app.localhost" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.app.inject({
          url: "/auth/session-handoff/start?return_path=%2Fsafe.html",
          headers: DEMO_HEADERS,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await f.app.inject({
          url: "/auth/session-handoff/complete?return_path=%2Fsafe.html",
          headers: { host: "app.localhost" },
        })
      ).statusCode,
    ).toBe(404);

    const appCookie = await f.organizationCookie("app");
    const issued = await f.app.inject({
      url: `/auth/session-handoff/start?return_path=${encodeURIComponent(RETURN_PATH)}`,
      headers: { host: "app.localhost", cookie: appCookie },
    });
    const complete = new URL(String(issued.headers.location));
    const ticket = complete.searchParams.get("ticket") ?? "";
    expect(ticket).not.toContain(appCookie.split("=", 2)[1]);
    const parts = ticket.split(".");
    const ciphertext = parts[2] ?? "";
    const replacement = ciphertext[0] === "A" ? "B" : "A";
    parts[2] = `${replacement}${ciphertext.slice(1)}`;
    const tampered = await f.app.inject({
      url: `/auth/session-handoff/complete?ticket=${encodeURIComponent(parts.join("."))}`,
      headers: DEMO_HEADERS,
    });
    expect(tampered.statusCode).toBe(400);
    expect(tampered.headers["set-cookie"]).toBeUndefined();

    const completed = await f.app.inject({
      url: `${complete.pathname}${complete.search}`,
      headers: DEMO_HEADERS,
    });
    expect(completed.statusCode).toBe(302);
    const replayed = await f.app.inject({
      url: `${complete.pathname}${complete.search}`,
      headers: DEMO_HEADERS,
    });
    expect(replayed.statusCode).toBe(400);
    expect(replayed.headers["set-cookie"]).toBeUndefined();
  });

  it("returns fixed no-store errors when handoff or content authorization storage fails", async () => {
    const repository = new InMemoryAuthRepository();
    const f = passwordFixture({ authRepository: repository });
    fixtures.push(f);
    vi.spyOn(repository, "findAccessSession").mockRejectedValue(
      new Error("database offline: postgres.internal:5432"),
    );
    const start = await f.app.inject({
      url: `/auth/session-handoff/start?return_path=${encodeURIComponent(RETURN_PATH)}`,
      headers: { host: "app.localhost", cookie: "html_share_app_session=broken" },
    });
    expect(start.statusCode).toBe(503);
    expect(start.headers["cache-control"]).toBe("no-store");
    expect(start.json()).toEqual({ error: "session_handoff_unavailable" });
    expect(start.body).not.toContain("postgres.internal");

    const content = await f.app.inject({
      url: RETURN_PATH,
      headers: { ...DEMO_HEADERS, cookie: "html_share_demo_session=broken" },
    });
    expect(content.statusCode).toBe(503);
    expect(content.headers["cache-control"]).toBe("no-store");
    expect(content.json()).toEqual({ error: "content_authorization_unavailable" });
    expect(content.body).not.toContain("postgres.internal");
  });

  it("returns a fixed no-store error when handoff consumption storage fails", async () => {
    const repository = new InMemoryAuthRepository();
    const f = passwordFixture({ authRepository: repository });
    fixtures.push(f);
    const appCookie = await f.organizationCookie("app");
    const issued = await f.app.inject({
      url: `/auth/session-handoff/start?return_path=${encodeURIComponent(RETURN_PATH)}`,
      headers: { host: "app.localhost", cookie: appCookie },
    });
    vi.spyOn(repository, "consumeAuthState").mockRejectedValue(
      new Error("database offline: postgres.internal:5432"),
    );
    const complete = new URL(String(issued.headers.location));
    const response = await f.app.inject({
      url: `${complete.pathname}${complete.search}`,
      headers: DEMO_HEADERS,
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ error: "session_handoff_unavailable" });
    expect(response.body).not.toContain("postgres.internal");
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
});
