import { expect, test, type Page } from "@playwright/test";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Password browser harness must provide ${name}`);
  return value;
}

const baseUrl = required("PASSWORD_BROWSER_DEMO_URL");
const appUrl = required("PASSWORD_BROWSER_APP_URL");
const targetPath = required("PASSWORD_BROWSER_TARGET_PATH");
const password = required("PASSWORD_BROWSER_PASSWORD");
const otherPath = required("PASSWORD_BROWSER_OTHER_PATH");
const targetUrl = new URL(targetPath, baseUrl).toString();

// Traces record request bodies. Never persist the real fixture password in trace files.
test.use({ trace: "off", video: "off" });

async function openPasswordPage(page: Page) {
  await page.goto(targetUrl);
  await expect(page.getByRole("heading", { name: "此链接已开启密码访问" })).toBeVisible();
  await expect(page.getByRole("link", { name: "钉钉登录打开" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("return_path")).toBe(targetPath);
}

async function screenshot(page: Page, name: string) {
  await page.screenshot({
    path: test.info().outputPath(`${name}.png`),
    fullPage: true,
    mask: [page.getByLabel("访问密码")],
  });
}

async function expectFixture(page: Page) {
  await expect(page).toHaveURL(targetUrl);
  await expect(page.locator("#fixture")).toHaveText("Protected fixture");
  await expect(page.locator("html")).toHaveAttribute("data-loaded", "yes");
  await expect(page.locator("body")).toHaveCSS("color", "rgb(12, 34, 56)");
  await expect
    .poll(() =>
      page.locator("#asset").evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBe(1);
}

for (const width of [1280, 375]) {
  test(`${width}px 密码页键盘焦点、空值、错误、网络与429均可重试`, async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize({ width, height: 820 });
    await openPasswordPage(page);
    const field = page.getByLabel("访问密码");
    const button = page.getByRole("button", { name: "打开链接" });
    const status = page.getByRole("status");
    await expect(field).toHaveAttribute("type", "password");
    await field.focus();
    // WebKit's default macOS navigation skips non-text controls with plain Tab.
    // Option/Alt+Tab navigates all controls: https://bugs.webkit.org/show_bug.cgi?id=272584
    const nextControl = browserName === "webkit" ? "Alt+Tab" : "Tab";
    const previousControl = browserName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab";
    await page.keyboard.press(nextControl);
    await expect(button).toBeFocused();
    expect(await button.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
      "none",
    );
    await page.keyboard.press(nextControl);
    await expect(page.getByRole("link", { name: "钉钉登录打开" })).toBeFocused();
    await page.keyboard.press(previousControl);
    await expect(button).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await screenshot(page, `password-${width}-default`);

    await field.press("Enter");
    await expect(status).toHaveText("请输入访问密码");
    await expect(field).toBeFocused();
    await field.fill("incorrect-password");
    await field.press("Enter");
    await expect(status).toHaveText("密码错误，请重试");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await screenshot(page, `password-${width}-wrong`);

    await page.route("**/auth/password/verify", (route) => route.abort("failed"));
    await button.click();
    await expect(status).toHaveText("网络连接失败，请检查网络后重试");
    await expect(button).toBeEnabled();
    await page.unroute("**/auth/password/verify");
    await page.route("**/auth/password/verify", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        headers: { "retry-after": "17" },
        body: JSON.stringify({ error: "尝试次数过多，请稍后重试" }),
      }),
    );
    await button.click();
    await expect(status).toContainText("17 秒后重试");
    await expect(button).toBeEnabled();
    await expect(page.getByRole("link", { name: "钉钉登录打开" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await screenshot(page, `password-${width}-rate-limited`);
  });
}

test("真实密码粘贴模拟与回车提交仅请求一次，子资源和同项目会话可用", async ({ page, context }) => {
  await openPasswordPage(page);
  const field = page.getByLabel("访问密码");
  let attempts = 0;
  let release = () => {
    /* Replaced by the request gate below. */
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/auth/password/verify", async (route) => {
    attempts += 1;
    await gate;
    await route.continue();
  });
  // Simulates paste handling; this is not a real-device OS clipboard test.
  await field.dispatchEvent("paste");
  await field.fill(password);
  await field.press("Enter");
  try {
    await expect(page.getByRole("button", { name: "正在验证…" })).toBeDisabled();
    await expect(field).toBeDisabled();
    await expect(page.locator("form")).toHaveAttribute("aria-busy", "true");
    await page.locator("form").dispatchEvent("submit");
    await expect.poll(() => attempts).toBe(1);
    await screenshot(page, "password-submitting");
  } finally {
    release();
  }
  await expectFixture(page);
  expect(attempts).toBe(1);
  await page.reload();
  await expectFixture(page);
  await screenshot(page, "password-authorized-fixture");
  const grant = (await context.cookies(baseUrl)).find(
    (item) =>
      item.name.startsWith("__Host-html_share_password_") && !item.name.endsWith("_browser"),
  );
  expect(grant).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
  expect(grant?.expires).toBeGreaterThan(Date.now() / 1000 + 7 * 60 * 60);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);

  const other = await context.request.get(new URL(otherPath, baseUrl).toString(), {
    maxRedirects: 0,
  });
  expect(other.status()).toBe(302);
  expect(await other.body()).toHaveLength(0);
  expect(other.headers()["etag"]).toBeUndefined();
  const start = new URL(other.headers()["location"] ?? "");
  expect(start.origin).toBe(appUrl);
  expect(start.pathname).toBe("/auth/session-handoff/start");
  const probe = await context.request.get(start.toString(), { maxRedirects: 0 });
  expect(probe.status()).toBe(302);
  expect(await probe.body()).toHaveLength(0);
  const completion = new URL(probe.headers()["location"] ?? "");
  expect(completion.origin).toBe(baseUrl);
  expect(completion.searchParams.has("ticket")).toBe(false);
  const completed = await context.request.get(completion.toString(), { maxRedirects: 0 });
  expect(completed.status()).toBe(302);
  expect(await completed.body()).toHaveLength(0);
  const returned = new URL(completed.headers()["location"] ?? "", baseUrl);
  expect(returned.origin).toBe(baseUrl);
  expect(returned.pathname + returned.search).toBe(otherPath);
  const denied = await context.request.get(returned.toString(), { maxRedirects: 0 });
  expect(denied.status()).toBe(302);
  expect(await denied.body()).toHaveLength(0);
  expect(denied.headers()["etag"]).toBeUndefined();
  const passwordEntry = new URL(denied.headers()["location"] ?? "", baseUrl);
  expect(passwordEntry.origin).toBe(baseUrl);
  expect(passwordEntry.pathname).toBe("/auth/password");
  expect(passwordEntry.searchParams.get("return_path")).toBe(otherPath);
  const deniedPage = await context.request.get(passwordEntry.toString(), { maxRedirects: 0 });
  expect(deniedPage.status()).toBe(200);
  expect(await deniedPage.text()).toContain("此链接已开启密码访问");
  expect(await deniedPage.text()).not.toContain("Protected fixture");
  for (const path of ["/api/projects", "/api/tokens", "/auth/current"])
    expect((await context.request.get(new URL(path, baseUrl).toString())).status()).toBe(404);
  expect(
    (
      await context.request.post(new URL("/mcp", baseUrl).toString(), {
        data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      })
    ).status(),
  ).toBe(404);
});

test("外部浏览器主动选择钉钉后经模拟器准确回跳", async ({ page }) => {
  await openPasswordPage(page);
  await page.getByRole("link", { name: "钉钉登录打开" }).click();
  await expectFixture(page);
});

test.describe("无 JavaScript 的主动钉钉入口", () => {
  test.use({ javaScriptEnabled: false });
  test("密码页与登录页的真实链接可完成授权并准确回跳", async ({ page }) => {
    await openPasswordPage(page);
    // Playwright's text selector skips NOSCRIPT even when the browser renders it.
    const noScriptHint = page.locator("noscript p");
    await expect(noScriptHint).toHaveText("请启用 JavaScript 后输入访问密码，或选择钉钉登录打开。");
    await expect(noScriptHint).toBeVisible();
    await page.getByRole("link", { name: "钉钉登录打开" }).click();
    await expect(page).toHaveURL(/\/auth\/content-login\?/);
    await expect(page.getByRole("link", { name: "继续钉钉登录" })).toBeVisible();
    await screenshot(page, "organization-login-baseline");
    await page.getByRole("link", { name: "继续钉钉登录" }).click();
    await expect(page).toHaveURL(targetUrl);
    await expect(page.locator("#fixture")).toHaveText("Protected fixture");
    await expect(page.locator("body")).toHaveCSS("color", "rgb(12, 34, 56)");
    // The HTML is accessible while its JavaScript intentionally remains disabled.
    await expect(page.locator("html")).not.toHaveAttribute("data-loaded", "yes");
  });
});

test("钉钉授权失败保留返回密码入口并可重新输入", async ({ page }) => {
  await openPasswordPage(page);
  await page.route("**/auth/callback?**", async (route) => {
    const callback = new URL(route.request().url());
    callback.searchParams.set("code", "simulator-denied");
    await route.continue({ url: callback.toString() });
  });
  await page.getByRole("link", { name: "钉钉登录打开" }).click();
  await expect(page.getByRole("heading", { name: "此链接已开启密码访问" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("钉钉登录未完成");
  await expect(page.getByRole("link", { name: "钉钉登录打开" })).toBeVisible();
  await page.getByLabel("访问密码").fill(password);
  await page.getByLabel("访问密码").press("Enter");
  await expectFixture(page);
});

test.describe("钉钉内置浏览器模拟", () => {
  test.use({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) DingTalk/7.6.0" });
  test("密码页不自动调用免登，主动点击后才调用桥并准确回跳", async ({ page }) => {
    let bridgeCalls = 0;
    await page.exposeFunction("recordDingTalkBridge", () => {
      bridgeCalls += 1;
    });
    await page.addInitScript(() => {
      const host = window as typeof window & {
        recordDingTalkBridge(): Promise<void>;
        dd?: { requestAuthCode(input: { success(result: { code: string }): void }): void };
      };
      host.dd = {
        requestAuthCode(input) {
          void host.recordDingTalkBridge();
          input.success({ code: "simulator-member" });
        },
      };
    });
    await openPasswordPage(page);
    expect(bridgeCalls).toBe(0);
    await page.getByRole("link", { name: "钉钉登录打开" }).click();
    await expectFixture(page);
    expect(bridgeCalls).toBe(1);
  });
});
