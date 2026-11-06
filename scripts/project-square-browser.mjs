/* global document */
import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirectoryService } from "../packages/core/dist/index.js";
import { createSimulatorDirectoryProvider } from "../packages/dingtalk/dist/index.js";
import { createHarness } from "./password-smoke-support.mjs";
import { squareSmokeConfiguration, squareSession } from "./project-square-harness.mjs";
import { publishBrowserFixture } from "./database-browser-fixture.mjs";
import { waitForManagementWeb } from "./password-management-web-harness.mjs";
import {
  webUrl,
  signedContext,
  snapshot,
  touchTargets,
  squareList,
  readonlyDetail,
  saveScope,
  openContent,
} from "./project-square-browser-support.mjs";

// Requires an already-built production Web at 55500. Never builds or stops another process.
const directory = process.env.PHASE30_BROWSER_OUTPUT ?? join(tmpdir(), "html-share-square");
let assertions = 0;
let stage = "startup";
const check = (value, message) => {
  assert(value, message);
  assertions++;
};
const reports = [];
try {
  check(process.versions.node.split(".")[0] === "24", "Node 24 is required");
  await mkdir(directory, { recursive: true });
  await waitForManagementWeb(webUrl, check);
  for (const provider of ["postgresql", "mysql"]) {
    for (const engine of [chromium, webkit]) {
      const prefix = `${provider}-${engine.name()}`;
      stage = `${prefix}:setup`;
      const h = await createHarness(squareSmokeConfiguration(provider), check, {
        squareDirectory: createDirectoryService(createSimulatorDirectoryProvider()),
        passwordAccess: true,
        appWebUrl: webUrl,
      });
      let browser;
      try {
        const published = await publishBrowserFixture(h, check);
        browser = await engine.launch();
        await lifecycle(h, browser, published, prefix);
        reports.push({ provider, browser: engine.name(), status: "passed" });
        console.log(
          JSON.stringify({
            status: "project-square-browser-case-ok",
            provider,
            browser: engine.name(),
          }),
        );
      } finally {
        try {
          if (browser) await browser.close();
        } finally {
          await h.cleanup();
        }
      }
    }
  }
  console.log(
    JSON.stringify({
      status: "project-square-browser-ok",
      assertions,
      reports,
      productionWeb: true,
      realDatabaseAndMinio: true,
      syntheticDirectory: true,
      interceptedApi: false,
      widths: [1440, 1065, 375],
      cssZoom: "200% at 750 CSS px",
      screenshotDirectory: directory,
    }),
  );
} catch (error) {
  // Playwright failures can include response values, so only names/locations leave memory.
  console.error(
    JSON.stringify({
      status: "project-square-browser-failed",
      stage,
      type: error?.name ?? "unknown",
      locations: [
        ...(error?.stack ?? "").matchAll(/project-square-browser[-a-z]*\.mjs:\d+:\d+/g),
      ].map((item) => item[0]),
    }),
  );
  process.exitCode = 1;
}

async function lifecycle(h, browser, published, prefix) {
  const key = published.result.project_id;
  const secret = published.result.access_password;
  const secrets = new Set([
    secret,
    h.mcpToken,
    h.appSessionToken,
    process.env.PASSWORD_RESULT_ENCRYPTION_KEY,
    process.env.PASSWORD_MANAGEMENT_ENCRYPTION_KEY,
  ]);
  const owner = await signedContext(browser, h.appCookie, secrets);
  const viewer = await signedContext(
    browser,
    await squareSession(h, "simulator-member-002"),
    secrets,
  );
  const outside = await signedContext(
    browser,
    await squareSession(h, "simulator-member-003"),
    secrets,
  );
  const contexts = [owner, viewer, outside];
  const page = owner.page;
  const panel = page.getByRole("region", { name: "广场共享" });
  const capture = (page, name) => snapshot(page, check, directory, prefix, name);
  try {
    stage = `${prefix}:default-and-picker`;
    await page.goto(`${webUrl}/demos`);
    await expect(
      page.getByRole("link", { name: "广场设置" }).filter({ visible: true }),
    ).toHaveCount(1);
    await capture(page, "my-demos-1440");
    await squareList(viewer.page, 0);
    await page.getByRole("link", { name: "广场设置" }).filter({ visible: true }).click();
    await expect(panel.getByText("未共享", { exact: true })).toBeVisible();
    const publish = panel.getByRole("button", { name: "发布到广场", exact: true });
    await expect(publish).toBeDisabled();
    await expect(panel.getByRole("radio", { name: "全组织", exact: true })).not.toBeChecked();
    await panel.getByRole("radio", { name: "指定部门 / 人员" }).check();
    await panel.getByRole("button", { name: "展开模拟组织", exact: true }).click();
    await panel
      .getByRole("checkbox", { name: "产品部（含子部门） 模拟组织 / 产品部", exact: true })
      .check();
    await panel.getByRole("button", { name: "展开产品部", exact: true }).click();
    await panel
      .getByRole("checkbox", { name: "设计组（含子部门） 模拟组织 / 产品部 / 设计组", exact: true })
      .check();
    await touchTargets(panel, check);
    await panel.getByRole("button", { name: "移除部门：设计组", exact: true }).click();
    await panel.getByRole("searchbox", { name: "搜索部门或姓名" }).fill("模拟非创建者");
    await expect(panel.getByRole("checkbox")).toHaveCount(2);
    await panel
      .getByRole("checkbox", { name: "模拟非创建者 模拟组织 / 研发部 / 设计组", exact: true })
      .check();
    await expect(panel.getByText("已选 2 / 100 项", { exact: true })).toBeVisible();
    check(
      (await h.prisma.user.count({
        where: { tenantId: h.tenantId, dingtalkUserId: "simulator-user-005" },
      })) === 0,
      "Directory can select a person who has never signed in",
    );
    await squareList(viewer.page, 0);
    await publish.click();
    await expect(page.getByRole("button", { name: "取消", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "确认发布", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(publish).toBeFocused();
    await squareList(viewer.page, 0);
    await publish.click();
    const saved = await saveScope(page, check, "确认发布");
    check(
      saved.settings.departmentIds.join() === "10" &&
        saved.settings.userIds.join() === "simulator-enterprise-user-005",
      "Real UI stores mixed stable IDs without the removed child department",
    );
    await page.reload();
    await expect(panel.getByText("已选 2 / 100 项", { exact: true })).toBeVisible();
    await expect(panel.getByText("已共享", { exact: true })).toBeVisible();

    stage = `${prefix}:scope-and-readonly`;
    const explicit = await signedContext(
      browser,
      await squareSession(h, "simulator-member-005"),
      secrets,
    );
    contexts.push(explicit);
    await squareList(explicit.page, 1);
    await squareList(outside.page, 0);
    await outside.page.getByRole("searchbox", { name: "搜索项目名" }).fill("Phase26");
    await expect(outside.page.getByText("共 0 个匹配项目", { exact: true })).toBeVisible();
    await outside.page.goto(`${webUrl}/square/${key}`);
    await expect(outside.page.getByRole("heading", { name: "项目不存在或无法访问" })).toBeVisible();
    const detail = await readonlyDetail(viewer.page, key, check, secret);
    const file = detail.files.find((item) => item.relativePath === "nested/测试 file.html");
    check(file !== undefined, "Nested Unicode HTML is present in current revision");
    // The real dual-domain relay must preserve organization authorization without a password prompt.
    await openContent(viewer.context, viewer.page, file.url, check);
    const linked = await outside.context.newPage();
    await linked.goto(file.url);
    await expect(linked.getByRole("heading", { name: "version phase26" })).toBeVisible();
    await linked.close();
    check(true, "Out-of-range member still opens an accurate organization content link");

    stage = `${prefix}:responsive`;
    for (const width of [1440, 1065, 375, 750]) {
      const zoom = width === 750 ? 2 : 1;
      const name = width === 750 ? "200percent" : String(width);
      for (const current of [page, viewer.page])
        await current.setViewportSize({ width, height: 1000 });
      await page.evaluate((value) => {
        document.documentElement.style.zoom = String(value);
      }, zoom);
      await panel.getByRole("searchbox", { name: "搜索部门或姓名" }).fill("");
      await expect(panel.getByRole("button", { name: "展开模拟组织", exact: true })).toBeVisible();
      await touchTargets(panel, check);
      await capture(page, `settings-${name}`);
      await squareList(viewer.page, 1);
      await viewer.page.evaluate((value) => {
        document.documentElement.style.zoom = String(value);
      }, zoom);
      await capture(viewer.page, `square-${name}`);
      await viewer.page.getByRole("searchbox", { name: "搜索项目名" }).fill("不存在");
      await expect(viewer.page.getByText("没有匹配的项目。", { exact: true })).toBeVisible();
      await viewer.page.getByRole("button", { name: "清空搜索", exact: true }).click();
      await expect(viewer.page.getByText("共 1 个可见项目", { exact: true })).toBeVisible();
      await viewer.page.getByRole("combobox", { name: "每页条数" }).selectOption("20");
      await expect(viewer.page.getByText("第 1 / 1 页", { exact: true })).toBeVisible();
      await readonlyDetail(viewer.page, key, check, secret);
      await viewer.page.evaluate((value) => {
        document.documentElement.style.zoom = String(value);
      }, zoom);
      await viewer.page.getByRole("searchbox", { name: "搜索文件名" }).fill("nested/测试");
      await expect(viewer.page.getByText("显示 1 / 3 个文件", { exact: true })).toBeVisible();
      await capture(viewer.page, `detail-${name}`);
    }

    stage = `${prefix}:shrink-withdraw-republish`;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "1";
    });
    await panel.getByRole("button", { name: "移除部门：产品部", exact: true }).click();
    await saveScope(page, check, "保存范围");
    await viewer.page.getByRole("button", { name: "重新加载", exact: true }).click();
    await expect(viewer.page.getByRole("heading", { name: "项目不存在或无法访问" })).toBeVisible();
    await expect(viewer.page.getByRole("listitem")).toHaveCount(0);
    await squareList(viewer.page, 0);
    await squareList(explicit.page, 1);
    const closed = await saveScope(page, check, "关闭共享");
    check(
      !closed.settings.enabled &&
        closed.settings.userIds.join() === "simulator-enterprise-user-005",
      "Withdrawal preserves the last explicit audience",
    );
    await squareList(explicit.page, 0);
    const afterWithdrawal = await outside.context.newPage();
    await afterWithdrawal.goto(file.url);
    await expect(afterWithdrawal.getByRole("heading", { name: "version phase26" })).toBeVisible();
    await afterWithdrawal.close();
    await publish.click();
    await expect(page.getByRole("dialog")).toContainText("1 位人员");
    await squareList(explicit.page, 0);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await panel.getByRole("radio", { name: "全组织", exact: true }).check();
    await publish.click();
    await saveScope(page, check, "确认发布");
    await squareList(outside.page, 1);
    await squareList(viewer.page, 1);
    for (const current of contexts.slice(1)) {
      check(
        current.ownerRequests.length === 0,
        "Read-only browser never requests any owner /api/projects endpoint",
      );
    }
    for (const current of contexts) {
      check(current.errors.length === 0, "Browser has no uncaught page errors");
      check(current.consoleSafe(), "Browser console contains no captured credentials");
    }
    check(
      h.publicationMetrics().worker.getObjectCalls === 0 &&
        h.publicationMetrics().worker.bodyBytesRead === 0,
      "Real publication validation reads no object body",
    );
  } finally {
    for (const current of contexts) await current.context.close();
  }
}
