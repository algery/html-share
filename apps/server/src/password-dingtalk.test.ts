import { afterEach, describe, expect, it } from "vitest";
import {
  cookies,
  DEMO_HEADERS,
  pageState,
  passwordFixture,
  RETURN_PATH,
} from "./password-access.test-helper.js";

const fixtures: ReturnType<typeof passwordFixture>[] = [];
function fixture() {
  const value = passwordFixture();
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(({ app }) => app.close()));
});
async function begin(f: ReturnType<typeof passwordFixture>) {
  const page = await f.passwordPage();
  const browser = cookies(page);
  const url = `/auth/content-login?${new URLSearchParams({ return_path: RETURN_PATH, password_return: pageState(page.body) })}`;
  const login = await f.app.inject({ url, headers: { ...DEMO_HEADERS, cookie: browser } });
  expect(login.statusCode).toBe(200);
  return { state: pageState(login.body), cookie: `${browser}; ${cookies(login)}` };
}

describe("password page DingTalk choice", () => {
  it.each([false, true])(
    "restores exact encoded path after DingTalk success (internal=%s)",
    async (internal) => {
      const f = fixture();
      const auth = await begin(f);
      const result = await f.app.inject(
        internal
          ? {
              method: "POST",
              url: "/auth/internal/complete",
              headers: {
                ...DEMO_HEADERS,
                cookie: auth.cookie,
                origin: "https://demo.localhost",
                accept: "application/json",
              },
              payload: { state: auth.state, code: "simulator-member" },
            }
          : {
              url: `/auth/callback?${new URLSearchParams({ state: auth.state, code: "simulator-member" })}`,
              headers: { ...DEMO_HEADERS, cookie: auth.cookie },
            },
      );
      expect(result.statusCode).toBe(internal ? 200 : 302);
      expect(internal ? result.json().redirectUrl : result.headers.location).toBe(
        `https://demo.localhost${RETURN_PATH}`,
      );
      const content = await f.app.inject({
        url: RETURN_PATH,
        headers: { ...DEMO_HEADERS, cookie: cookies(result) },
      });
      expect(content.statusCode).toBe(200);
    },
  );

  it.each(["denied", "cancelled", "internal"])(
    "returns %s authorization to a fresh password page",
    async (kind) => {
      const f = fixture();
      const auth = await begin(f);
      const result = await f.app.inject(
        kind === "internal"
          ? {
              method: "POST",
              url: "/auth/internal/complete",
              headers: { ...DEMO_HEADERS, cookie: auth.cookie, origin: "https://demo.localhost" },
              payload: { state: auth.state, code: "simulator-denied" },
            }
          : {
              url: `/auth/callback?${new URLSearchParams({ state: auth.state, ...(kind === "cancelled" ? { error: "access_denied" } : { code: "simulator-denied" }) })}`,
              headers: { ...DEMO_HEADERS, cookie: auth.cookie },
            },
      );
      expect(result.statusCode).toBe(302);
      expect(result.headers.location).toBe(
        `/auth/password?return_path=${encodeURIComponent(RETURN_PATH)}&error=dingtalk`,
      );
      const retry = await f.app.inject({
        url: String(result.headers.location),
        headers: { ...DEMO_HEADERS, cookie: auth.cookie },
      });
      expect(retry.body).toContain("钉钉登录未完成");
      expect(retry.body).toContain("钉钉登录打开");
    },
  );

  it("rejects altered or cross-browser password return states before starting DingTalk", async () => {
    const f = fixture();
    const page = await f.passwordPage();
    const state = pageState(page.body);
    for (const params of [
      { return_path: RETURN_PATH, password_return: state + "x" },
      { return_path: "//evil.invalid", password_return: state },
      { return_path: "/abc12/style.css", password_return: state },
    ]) {
      const response = await f.app.inject({
        url: `/auth/content-login?${new URLSearchParams(params)}`,
        headers: { ...DEMO_HEADERS, cookie: cookies(page) },
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers.location).toBeUndefined();
    }
    const response = await f.app.inject({
      url: `/auth/content-login?${new URLSearchParams({ return_path: RETURN_PATH, password_return: state })}`,
      headers: DEMO_HEADERS,
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns 404 when the target disappears before choosing DingTalk", async () => {
    const f = fixture();
    const page = await f.passwordPage();
    f.setActive(false);
    const response = await f.app.inject({
      url: `/auth/content-login?${new URLSearchParams({ return_path: RETURN_PATH, password_return: pageState(page.body) })}`,
      headers: { ...DEMO_HEADERS, cookie: cookies(page) },
    });
    expect(response.statusCode).toBe(404);
  });

  it.each(["deleted", "removed-file"])("returns 404 for %s after DingTalk denial", async (kind) => {
    const f = fixture();
    const auth = await begin(f);
    if (kind === "deleted") f.setActive(false);
    else f.removeFile();
    const result = await f.app.inject({
      url: `/auth/callback?${new URLSearchParams({ state: auth.state, code: "simulator-denied" })}`,
      headers: { ...DEMO_HEADERS, cookie: auth.cookie },
    });
    expect(result.statusCode).toBe(404);
    expect(result.headers.location).toBeUndefined();
  });
});
