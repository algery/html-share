import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit, expect } from "@playwright/test";
import { readContractDatabases } from "../packages/db/dist/testing/database-fixture.js";
import { createHarness } from "./password-smoke-support.mjs";
import { publishBrowserFixture } from "./database-browser-fixture.mjs";
import {
  buildManagementWeb,
  startManagementWeb,
  waitForManagementWeb,
  stopProcess,
} from "./password-management-web-harness.mjs";
import { feishuOAuthFixture } from "./feishu-oauth-fixture.mjs";

const appUrl = "http://127.0.0.1:55100",
  webUrl = "http://127.0.0.1:55500",
  demoUrl = "http://localhost:55100";
const captureDirectory = process.env.FEISHU_SCREENSHOT_DIR ?? "/tmp/html-share-feishu-browser";
let assertions = 0;
const check = (value, message) => {
  assert(value, message);
  assertions++;
};
const configs = readContractDatabases();
await mkdir(captureDirectory, { recursive: true });
const provider = await feishuOAuthFixture();
let web;
try {
  if (process.env.FEISHU_REUSE_WEB_BUILD !== "true")
    await buildManagementWeb({ appUrl, webUrl, demoUrl, check });
  web = startManagementWeb({ appUrl, webUrl, demoUrl });
  await waitForManagementWeb(webUrl, check);
  for (const config of configs) {
    const h = await createHarness(
      {
        databaseProvider: config.DATABASE_PROVIDER,
        databaseUrl: config.DATABASE_URL,
        endpoint: "http://127.0.0.1:59008",
        accessKeyId: "password_test",
        accessKeySecret: "local-password-test-only",
      },
      check,
      {
        appUrl,
        appWebUrl: webUrl,
        demoUrl,
        passwordAccess: true,
        feishu: { client: provider.client, stateSecret: "s".repeat(32) },
      },
    );
    try {
      const tenant = await h.prisma.tenant.findUniqueOrThrow({ where: { id: h.tenantId } });
      const owner = await h.prisma.user.update({
        where: { id: h.ownerUserId },
        data: { dingtalkUserId: "simulator-user-001" },
      });
      await h.repositories.auth.upsertUser({
        tenantAppKeyRef: tenant.dingtalkAppKeyRef,
        dingtalkUserId: owner.dingtalkUserId,
        displayName: owner.displayName,
        email: "member@example.com",
        now: new Date(),
      });
      const fixture = await publishBrowserFixture(h, check);
      const path = `/${fixture.result.project_id}/nested/%E6%B5%8B%E8%AF%95%20file.html?preview=1`;
      for (const type of [chromium, webkit]) {
        const browser = await type.launch();
        try {
          for (const width of [1440, 375]) {
            const context = await browser.newContext({ viewport: { width, height: 900 } });
            const page = await context.newPage();
            try {
              provider.outcome("success");
              await page.goto(`${webUrl}/login`);
              await expect(page.getByRole("link", { name: "前往飞书授权" })).toBeVisible();
              await expect(page.getByRole("link", { name: "前往钉钉授权" })).toBeVisible();
              check(
                await page.evaluate(
                  () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
                ),
                "login has no horizontal overflow",
              );
              await page.screenshot({
                path: `${captureDirectory}/login-${config.DATABASE_PROVIDER}-${type.name()}-${width}.png`,
                fullPage: true,
              });
              await page.getByRole("link", { name: "前往飞书授权" }).click();
              await expect(page).toHaveURL(`${webUrl}/demos`);
              await expect(
                page.getByRole("heading", { name: "我的 Demo", exact: true }),
              ).toBeVisible();
              await expect(
                page.getByRole("link", { name: "Phase26 中文😀 浏览器项目", exact: true }),
              ).toBeVisible();
              check(
                (await h.prisma.user.count({ where: { tenantId: h.tenantId } })) === 1,
                "Feishu retains the original DingTalk user",
              );
              await page.goto(`${webUrl}/tokens`);
              await expect(
                page.getByText("Password smoke", { exact: true }).filter({ visible: true }),
              ).toBeVisible();
              const content = await context.newPage();
              await content.goto(demoUrl + path);
              await expect(content).toHaveURL(demoUrl + path);
              await expect(content.getByRole("heading")).toHaveText("version phase26");
              check(true, "app Feishu session hands off to content with exact path");
              await content.close();
              await page.getByRole("button", { name: "退出", exact: true }).click();
              await expect(page).toHaveURL(/\/login/);
              const current = await context.request.get(`${appUrl}/auth/current`);
              check(current.status() === 401, "logout revokes platform session");
              await context.clearCookies();
              // Password mode allows choosing Feishu directly without submitting a password.
              await page.goto(`${demoUrl}/auth/password?return_path=${encodeURIComponent(path)}`);
              await expect(page.getByRole("link", { name: "飞书登录打开" })).toBeVisible();
              check(
                await page
                  .getByRole("link", { name: "飞书登录打开" })
                  .evaluate(
                    (el) => Number.parseFloat(globalThis.getComputedStyle(el).marginTop) >= 12,
                  ),
                "password login buttons keep CSP-safe spacing",
              );
              await page.screenshot({
                path: `${captureDirectory}/password-${config.DATABASE_PROVIDER}-${type.name()}-${width}.png`,
                fullPage: true,
              });
              provider.outcome("cancel");
              await page.getByRole("link", { name: "飞书登录打开" }).click();
              await expect(
                page.getByText("组织登录未完成，请输入访问密码或重新登录。", { exact: true }),
              ).toBeVisible();
              check(
                !/[?&](code|state)=/.test(page.url()),
                "cancelled callback strips OAuth parameters",
              );
              provider.outcome("success");
              await page.getByRole("link", { name: "飞书登录打开" }).click();
              await expect(page).toHaveURL(demoUrl + path);
              await expect(page.getByRole("heading")).toHaveText("version phase26");
              check(true, "password choice returns to original protected bytes without password");
              await context.clearCookies();
              provider.outcome("foreign");
              await page.goto(`${appUrl}/auth/feishu/login`);
              await expect(page).toHaveURL(`${webUrl}/login?status=denied`);
              check(
                (await context.request.get(`${appUrl}/auth/current`)).status() === 401,
                "foreign tenant has no platform session",
              );
              provider.outcome("success");
              await page.goto(
                `${demoUrl}/auth/content-login?return_path=${encodeURIComponent(path)}`,
              );
              await expect(page.getByRole("link", { name: "飞书登录打开" })).toBeVisible();
              await page.getByRole("link", { name: "飞书登录打开" }).click();
              await expect(page).toHaveURL(demoUrl + path);
              check(true, "organization entry supports Feishu on both browsers");
            } finally {
              await context.close();
            }
          }
        } finally {
          await browser.close();
        }
      }
      console.log(`${config.DATABASE_PROVIDER}: Feishu browser flows passed`);
    } finally {
      await h.cleanup();
    }
  }
  console.log(
    `Feishu browser validation passed: ${assertions} assertions; Chromium/WebKit, 1440/375px, PostgreSQL/MySQL`,
  );
} finally {
  if (web) await stopProcess(web);
  await provider.close();
}
