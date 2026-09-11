import { expect, test, type Page } from "@playwright/test";

const webUrl = process.env.HTML_SHARE_DETAIL_WEB_URL ?? "http://localhost:3000";
const project = {
  accessMode: "organization" as const,
  passwordStatus: "disabled" as const,
  createdAt: "2026-09-07T00:00:00Z",
  updatedAt: "2026-09-07T01:00:00Z",
  displayName: "产品演示",
  projectId: "abc12",
  fileCount: 3,
  totalSize: 1024,
  projectPrefix: "http://demo.localhost:3001/abc12/",
};
const files = [
  "assets/app.js",
  "中文目录/页面 #?%&.html",
  `${"nested/".repeat(12)}long-page.html`,
].map((relativePath) => ({
  relativePath,
  size: 128,
  url: `http://demo.localhost:3001/abc12/${relativePath.split("/").map(encodeURIComponent).join("/")}`,
}));

test.beforeEach(async ({ page }) => {
  // All management requests are intercepted; these tests never write to a database.
  await page.route("**/auth/current", (route) =>
    route.fulfill({ json: { user: { displayName: "测试用户" }, csrfToken: "test-only" } }),
  );
  await page.route("**/api/projects", (route) =>
    route.fulfill({
      json: {
        projects: [project],
        csrfToken: "test-only",
        quota: {
          projectCount: 1,
          projectLimit: 100,
          storageBytes: 1024,
          storageLimitBytes: 2147483648,
        },
      },
    }),
  );
  await page.route("**/api/projects/abc12", (route) =>
    route.fulfill({ json: { csrfToken: "test-only", project, files } }),
  );
});

async function mockClipboard(page: Page, fail = false) {
  await page.addInitScript((fail) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          if (fail) throw new Error("permission denied");
          document.documentElement.dataset["copied"] = value;
        },
      },
    });
  }, fail);
}

for (const width of [1280, 375]) {
  test(`项目列表进入详情、复制和返回，${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockClipboard(page);
    await page.goto(`${webUrl}/demos`);
    await page
      .getByRole("link", { name: project.displayName, exact: true })
      .filter({ visible: true })
      .click();
    await expect(page).toHaveURL(`${webUrl}/demos/abc12`);
    await expect(
      page.getByRole("heading", { name: project.displayName, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "我的 Demo", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("heading", { name: "全部文件（3）" })).toBeVisible();
    for (const file of files) {
      const row = page.getByRole("listitem").filter({ hasText: file.relativePath });
      await expect(row.getByRole("link")).toHaveAttribute("href", file.url);
      await expect(row.getByRole("link")).toHaveAttribute("target", "_blank");
      await row.getByRole("button", { name: "复制链接" }).click();
      await expect(row).toContainText("已复制");
      await expect(page.locator("html")).toHaveAttribute("data-copied", file.url);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `/tmp/html-share-demo-detail-${width}-${test.info().project.name}.png`,
      fullPage: true,
    });
    await page.getByRole("link", { name: "返回我的 Demo" }).click();
    await expect(page.getByRole("heading", { name: "管理已发布的 Demo" })).toBeVisible();
    await page.screenshot({
      path: `/tmp/html-share-demo-list-${width}-${test.info().project.name}.png`,
      fullPage: true,
    });
  });
}

test("复制失败保留完整链接，支持手动复制", async ({ page }) => {
  await mockClipboard(page, true);
  await page.goto(`${webUrl}/demos/abc12`);
  const row = page.getByRole("listitem").first();
  await row.getByRole("button", { name: "复制链接" }).click();
  await expect(row).toContainText("复制失败，请手动复制");
  await expect(row.getByRole("textbox", { name: "手动复制内容" })).toHaveValue(files[0]?.url ?? "");
  await expect(row.getByRole("link")).toHaveText("http://demo.localhost:3001/abc12/assets/app.js");
});

for (const width of [1280, 375]) {
  test(`文件关键词搜索与紧凑布局，${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockClipboard(page);
    await page.goto(`${webUrl}/demos/abc12`);
    const search = page.getByRole("searchbox", { name: "搜索文件名" });

    await search.fill("  APP.JS  ");
    await expect(page.getByText("显示 1 / 3 个文件")).toBeVisible();
    await expect(page.getByRole("listitem")).toHaveCount(1);
    await expect(page.getByRole("listitem")).toContainText("assets/app.js");
    await page.getByRole("button", { name: "复制链接" }).click();
    await expect(page.getByRole("listitem")).toContainText("已复制");

    await search.fill("中文目录");
    await expect(page.getByRole("listitem")).toHaveCount(1);
    await expect(page.getByRole("listitem")).toContainText("中文目录/页面 #?%&.html");

    await search.fill("missing-file");
    await expect(page.getByText("没有匹配的文件。")).toBeVisible();
    await expect(page.getByRole("listitem")).toHaveCount(0);
    await page.getByRole("button", { name: "清空搜索" }).click();
    await expect(search).toHaveValue("");
    await expect(page.getByText("显示 3 / 3 个文件")).toBeVisible();
    await expect(page.getByRole("listitem")).toHaveCount(3);
    await expect(page.getByRole("listitem").locator("h3")).toHaveText(
      files.map((file) => file.relativePath),
    );
    const firstRow = page.getByRole("listitem").first();
    const compactLayout = await firstRow.evaluate((element) => {
      const link = element.querySelector("a");
      const button = element.querySelector("button");
      if (link === null || button === null) return null;
      const rowStyle = getComputedStyle(element);
      const linkRect = link.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      return {
        buttonHeight: buttonRect.height,
        buttonTop: buttonRect.top,
        linkBottom: linkRect.bottom,
        linkCenter: linkRect.top + linkRect.height / 2,
        buttonCenter: buttonRect.top + buttonRect.height / 2,
        paddingBottom: rowStyle.paddingBottom,
        paddingTop: rowStyle.paddingTop,
      };
    });
    expect(compactLayout).not.toBeNull();
    expect(compactLayout?.paddingTop).toBe("10px");
    expect(compactLayout?.paddingBottom).toBe("10px");
    expect(compactLayout?.buttonHeight).toBe(32);
    if (width >= 640) {
      expect(
        Math.abs((compactLayout?.linkCenter ?? 0) - (compactLayout?.buttonCenter ?? 0)),
      ).toBeLessThan(2);
    } else {
      expect(compactLayout?.buttonTop).toBeGreaterThanOrEqual(compactLayout?.linkBottom ?? 0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `/tmp/html-share-demo-detail-compact-${width}-${test.info().project.name}.png`,
      fullPage: true,
    });
  });
}

test("加载、失败重试、空清单及覆盖后刷新", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/projects/abc12", async (route) => {
    await held;
    await route.fulfill({ status: 503, json: { error: "unavailable" } });
  });
  await page.goto(`${webUrl}/demos/abc12`);
  await expect(page.getByRole("status", { name: "正在加载项目文件" })).toBeVisible();
  release();
  await expect(page.getByRole("heading", { name: "无法加载项目文件" })).toBeVisible();
  await page.route("**/api/projects/abc12", (route) =>
    route.fulfill({ json: { project: { ...project, fileCount: 0, totalSize: 0 }, files: [] } }),
  );
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByText("当前项目暂无已发布文件。")).toBeVisible();
  const replacement = {
    relativePath: "new.html",
    size: 1,
    url: "http://demo.localhost:3001/abc12/new.html",
  };
  await page.route("**/api/projects/abc12", (route) =>
    route.fulfill({
      json: { project: { ...project, fileCount: 1, totalSize: 1 }, files: [replacement] },
    }),
  );
  await page.getByRole("button", { name: "重新加载" }).click();
  await expect(page.getByRole("heading", { name: "全部文件（1）" })).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("listitem")).toContainText("new.html");
});

for (const [status, title] of [
  [401, "登录状态已过期"],
  [404, "项目不存在或无法访问"],
] as const) {
  test(`详情 ${status} 状态`, async ({ page }) => {
    await page.route("**/api/projects/abc12", (route) =>
      route.fulfill({ status, json: { error: "unavailable" } }),
    );
    await page.goto(`${webUrl}/demos/abc12`);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByRole("listitem")).toHaveCount(0);
    if (status === 401)
      await expect(page.getByRole("link", { name: "前往登录" })).toHaveAttribute("href", "/login");
    await expect(page.getByRole("link", { name: "返回我的 Demo" })).toBeVisible();
  });
}

test("网络中断展示重试入口", async ({ page }) => {
  await page.route("**/api/projects/abc12", (route) => route.abort());
  await page.goto(`${webUrl}/demos/abc12`);
  await expect(page.getByRole("heading", { name: "无法加载项目文件" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
});
