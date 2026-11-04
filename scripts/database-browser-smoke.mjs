import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, isolatedConfiguration } from "./password-smoke-support.mjs";
import {
  buildManagementWeb,
  startManagementWeb,
  stopProcess,
  waitForManagementWeb,
} from "./password-management-web-harness.mjs";
import { publishBrowserFixture } from "./database-browser-fixture.mjs";
import { runCaptured } from "./database-compatibility-support.mjs";

const appUrl = "http://127.0.0.1:55100";
const webUrl = "http://127.0.0.1:55500";
const demoUrl = "http://localhost:55100";
let assertions = 0;
const check = (condition, message) => {
  assert(condition, message);
  assertions++;
};
const config = isolatedConfiguration();
const h = await createHarness(config, check, {
  appUrl,
  appWebUrl: webUrl,
  demoUrl,
  passwordAccess: true,
});
const secrets = new Set([
  h.mcpToken,
  h.appSessionToken,
  process.env.PASSWORD_RESULT_ENCRYPTION_KEY,
  process.env.PASSWORD_MANAGEMENT_ENCRYPTION_KEY,
]);
let web;
let directory;
try {
  await h.prisma.user.update({
    where: { id: h.ownerUserId },
    data: { dingtalkUserId: "simulator-user-001" },
  });
  const published = await publishBrowserFixture(h, check);
  secrets.add(published.result.access_password);
  await buildManagementWeb({ appUrl, check, demoUrl, webUrl });
  web = startManagementWeb({ appUrl, demoUrl, webUrl });
  await waitForManagementWeb(webUrl, check);
  for (const type of [chromium, webkit]) {
    const browser = await type.launch();
    try {
      for (const width of [1440, 1065, 375])
        await lifecycle(browser, type.name(), width, published);
    } finally {
      await browser.close();
    }
  }
  directory = await mkdtemp(join(tmpdir(), "html-share-phase26-browser-"));
  const reportPath = process.env.PHASE26_BROWSER_MOCK_REPORT ?? join(directory, "mock.json");
  runCaptured(
    "node_modules/@playwright/test/cli.js",
    {
      HTML_SHARE_DETAIL_WEB_URL: webUrl,
      HTML_SHARE_INSTALL_WEB_URL: webUrl,
      PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
    },
    [
      "test",
      "tests/browser/demo-detail.spec.ts",
      "tests/browser/demo-list-homepage.spec.ts",
      "tests/browser/demo-list-share.spec.ts",
      "tests/browser/demo-homepage-states.spec.ts",
      "tests/browser/password-management.spec.ts",
      "tests/browser/password-install-guide.spec.ts",
      "--workers=1",
      "--reporter=json",
    ],
    600_000,
  );
  const mock = JSON.parse(await readFile(reportPath, "utf8"));
  check(
    mock.stats.expected > 0 &&
      mock.stats.unexpected === 0 &&
      mock.stats.skipped === 0 &&
      mock.stats.flaky === 0,
    "Existing intercepted-API regression passes separately without skips",
  );
  console.log(
    JSON.stringify({
      status: "database-browser-smoke-ok",
      assertions,
      provider: config.databaseProvider ?? "postgresql",
      browsers: ["chromium", "webkit"],
      widths: [1440, 1065, 375],
      productionWeb: true,
      mockAssertions: mock.stats.expected,
    }),
  );
} catch (error) {
  console.error(
    `Real database browser smoke failed (${error?.name ?? "unknown"}; locations=${[...(error?.stack ?? "").matchAll(/database-browser[-a-z]*\.mjs:\d+:\d+/g)].map((item) => item[0]).join(",") || "setup"}); captured credential values are withheld`,
  );
  process.exitCode = 1;
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
  if (web) await stopProcess(web);
  await h.cleanup();
}

async function lifecycle(browser, browserName, width, published) {
  const context = await browser.newContext({ viewport: { width, height: 1026 } });
  try {
    await context.addInitScript(() =>
      Object.defineProperty(globalThis.navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value) => {
            globalThis.document.documentElement.dataset.copied = value;
          },
        },
      }),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${webUrl}/login`);
    await page.getByRole("link", { name: "前往钉钉授权" }).click();
    await expect(page).toHaveURL(`${webUrl}/demos`);
    const current = await context.request.get(`${appUrl}/auth/current`);
    check(
      current.status() === 200 &&
        (await current.json()).user.dingtalkUserId === "simulator-user-001",
      "Real simulator OAuth login resolves persisted fixture owner",
    );
    await layout(page, "home");
    await page.goto(`${webUrl}/tokens`);
    const tokenName = `Phase26 ${browserName} ${width}`;
    await page.getByLabel("Token 名称").fill(tokenName);
    await page.getByRole("button", { name: "创建 Token", exact: true }).click();
    await expect(page.getByRole("heading", { name: "请立即复制 Token" })).toBeVisible();
    secrets.add(
      await page.locator("section[aria-labelledby=created-token-title] code").textContent(),
    );
    await layout(page, "token");
    await page.getByRole("button", { name: "我已保存" }).click();
    const tokenRow = page.locator(width >= 768 ? "tr" : "article").filter({ hasText: tokenName });
    page.once("dialog", (dialog) => dialog.accept());
    await tokenRow.getByRole("button", { name: "吊销" }).click();
    await expect(tokenRow).toContainText("已吊销");
    check(
      (
        await h.prisma.mcpToken.findFirstOrThrow({
          where: { userId: h.ownerUserId, name: tokenName },
        })
      ).revokedAt !== null,
      "UI token revocation persists in selected database",
    );
    await page.goto(`${webUrl}/demos/${published.result.project_id}`);
    await expect(page.getByRole("heading", { name: "全部文件（3）" })).toBeVisible();
    const select = page.getByRole("combobox", { name: "首页文件" });
    await select.selectOption("nested/测试 file.html");
    const homepageResponse = page.waitForResponse(
      (response) => response.url().endsWith("/homepage") && response.request().method() === "PUT",
      { timeout: 5000 },
    );
    await page.getByRole("button", { name: "保存首页" }).click();
    check((await homepageResponse).status() === 200, "Real homepage API accepts browser save");
    await expect(page.locator("#project-homepage").getByRole("status")).toHaveText("首页已保存。");
    await page.reload();
    await expect(select).toHaveValue("nested/测试 file.html");
    await layout(page, "detail");
    const project = await h.prisma.demoProject.findUniqueOrThrow({
      where: { projectKey: published.result.project_id },
    });
    check(
      project.homepagePath === "nested/测试 file.html",
      "UI homepage selection survives real reload",
    );
    await page.goto(`${webUrl}/demos`);
    await page.getByRole("searchbox", { name: "搜索项目名" }).fill("Phase26 中文😀");
    const row = page
      .locator(width >= 768 ? "tbody tr" : "article")
      .filter({ hasText: published.result.project_id });
    await expect(row).toHaveCount(1);
    const oldUrl = await row
      .getByRole("link", { name: "nested/测试 file.html", exact: true })
      .getAttribute("href");
    await layout(page, "list");
    // Keep this list stale while a separate real detail tab changes homepage/password.
    const editor = await context.newPage();
    await editor.goto(`${webUrl}/demos/${published.result.project_id}`);
    await editor.getByRole("combobox", { name: "首页文件" }).selectOption(published.alternate);
    await editor.getByRole("button", { name: "保存首页" }).click();
    await expect(editor.locator("#project-homepage").getByRole("status")).toHaveText(
      "首页已保存。",
    );
    await editor.getByRole("button", { name: "重新生成密码" }).click();
    await editor.getByRole("button", { name: "确认重新生成" }).click();
    await expect(editor.getByText("已重新生成密码，旧密码已失效。", { exact: true })).toBeVisible();
    const detail = await context.request.get(
      `${appUrl}/api/projects/${published.result.project_id}`,
    );
    const { project: latest } = await detail.json();
    secrets.add(latest.accessPassword);
    check(
      detail.status() === 200 &&
        latest.homepage.url !== oldUrl &&
        latest.passwordStatus === "available",
      "Real detail returns changed homepage and current password",
    );
    await row.getByRole("button", { name: "复制链接和密码" }).click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-copied",
      `链接：${latest.homepage.url}\n密码：${latest.accessPassword}`,
    );
    check(true, "Stale list copies latest link and password from the real backend");
    await editor.close();
    check(
      await page.evaluate(
        async () =>
          globalThis.localStorage.length === 0 &&
          globalThis.sessionStorage.length === 0 &&
          (await globalThis.indexedDB.databases()).length === 0,
      ),
      "Production browser stores no passwords in browser storage",
    );
    if (errors.length)
      console.error(
        JSON.stringify({
          stage: "browser-page-errors",
          browserName,
          width,
          errors: errors.map((message) =>
            [...secrets]
              .filter(Boolean)
              .reduce((redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"), message),
          ),
        }),
      );
    check(errors.length === 0, "Real browser has no uncaught page errors");
  } finally {
    await context.close();
  }
}

async function layout(page, name) {
  check(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
    ),
    `${name} does not overflow viewport`,
  );
  for (const table of name === "list" || name === "home"
    ? await page.locator("table").filter({ visible: true }).all()
    : []) {
    check(
      await table.evaluate(
        (element) => element.parentElement.scrollWidth <= element.parentElement.clientWidth,
      ),
      `${name} table fits its container`,
    );
  }
  const buttons = page.getByRole("button").filter({ visible: true });
  for (const button of await buttons.all()) {
    check(
      await button.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      `${name} button text fits`,
    );
  }
}
