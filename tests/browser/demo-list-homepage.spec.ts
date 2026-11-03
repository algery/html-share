import { expect, test, type Page } from "@playwright/test";

const webUrl = process.env.HTML_SHARE_DETAIL_WEB_URL ?? "http://localhost:3000";
const base = {
  accessMode: "password",
  passwordStatus: "unavailable",
  createdAt: "2026-09-03T00:00:00Z",
  updatedAt: "2026-11-03T00:00:00Z",
  fileCount: 3,
  totalSize: 100,
  homepage: {
    path: "index.html",
    configuredPath: null as string | null,
    source: "automatic",
    url: "http://demo.localhost:3001/abc12/index.html" as string | null,
  },
};
const paths = ["index.html", "中文目录/演示 #.HTML", "assets/app.js"];
const files = paths.map((relativePath) => ({
  relativePath,
  size: 10,
  url: `http://demo.localhost:3001/abc12/${relativePath.split("/").map(encodeURIComponent).join("/")}`,
}));

async function mockApp(page: Page, count = 23, clipboardFails = false) {
  let projects = Array.from({ length: count }, (_, index) => ({
    ...base,
    projectId: index === 0 ? "abc12" : String(index).padStart(5, "0"),
    displayName:
      index === 0
        ? "Phase 9 capacity 10 超长项目名称用于验证单行省略展示"
        : `Demo project ${index + 1}`,
    homepage: { ...base.homepage },
  }));
  await page.addInitScript(
    (fail) =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            if (fail) throw new Error("denied");
            document.documentElement.dataset["copied"] = value;
          },
        },
      }),
    clipboardFails,
  );
  await page.route("**/auth/current", (route) =>
    route.fulfill({ json: { user: { displayName: "测试用户" }, csrfToken: "test-only" } }),
  );
  await page.route("**/api/projects", (route) =>
    route.fulfill({
      json: {
        csrfToken: "test-only",
        projects,
        quota: {
          projectCount: projects.length,
          projectLimit: 100,
          storageBytes: projects.length * 100,
          storageLimitBytes: 2147483648,
        },
      },
    }),
  );
  await page.route("**/api/projects/*/delete", async (route) => {
    const id = route.request().url().split("/").at(-2);
    expect(route.request().headers()["x-html-share-csrf"]).toBe("test-only");
    projects = projects.filter((project) => project.projectId !== id);
    await route.fulfill({ json: { status: "deleted" } });
  });
  await page.route("**/api/projects/abc12", (route) =>
    route.fulfill({
      json: {
        csrfToken: "test-only",
        project: { ...projects[0], passwordStatus: "available", accessPassword: "Abcd2345" },
        files,
      },
    }),
  );
  await page.route("**/api/projects/abc12/homepage", async (route) => {
    expect(route.request().method()).toBe("PUT");
    expect(route.request().headers()["x-html-share-csrf"]).toBe("test-only");
    const { relativePath } = route.request().postDataJSON() as { relativePath: string | null };
    const project = projects[0];
    if (!project) throw new Error("missing project");
    const path = relativePath ?? "index.html";
    project.homepage = {
      configuredPath: relativePath,
      source: relativePath ? "manual" : "automatic",
      path,
      url: files.find((file) => file.relativePath === path)?.url ?? null,
    };
    await route.fulfill({ json: { status: "updated" } });
  });
}

for (const width of [1065, 375]) {
  test(`搜索全量项目、分页、刷新与布局 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1026 });
    await mockApp(page, 74);
    await page.goto(`${webUrl}/demos`);
    const rows = width >= 768 ? page.locator("tbody tr") : page.locator("article");
    await expect(rows).toHaveCount(10);
    await expect(page.getByText("第 1 / 8 页")).toBeVisible();
    await expect(page.getByRole("button", { name: "上一页" })).toBeDisabled();
    if (width >= 768) {
      expect(
        await page.locator("table").evaluate((table) => {
          const container = table.parentElement;
          return container !== null && container.scrollWidth <= container.clientWidth;
        }),
      ).toBe(true);
      expect(
        await rows
          .first()
          .locator("td")
          .first()
          .evaluate((element) => element.getBoundingClientRect().width),
      ).toBeGreaterThanOrEqual(240);
      const badge = rows.first().getByText("密码访问");
      await expect(badge).toHaveCSS("white-space", "nowrap");
      await expect(badge).toHaveCSS("font-size", "12px");
      await expect(rows.first().getByRole("link").first()).toHaveAttribute(
        "title",
        /Phase 9 capacity/,
      );
    }
    await page.screenshot({
      path: `/tmp/html-share-list-after-${width}-${test.info().project.name}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "下一页" }).click();
    await expect(page.getByText("第 2 / 8 页")).toBeVisible();
    await page.getByRole("combobox", { name: "每页条数" }).selectOption("50");
    await expect(rows).toHaveCount(50);
    await page.getByRole("button", { name: "下一页" }).click();
    await expect(rows).toHaveCount(24);
    await expect(page.getByRole("button", { name: "下一页" })).toBeDisabled();
    const search = page.getByRole("searchbox", { name: "搜索项目名" });
    await search.fill("  DEMO PROJECT 74  ");
    await expect(rows).toHaveCount(1);
    await expect(page.getByText("第 1 / 1 页")).toBeVisible();
    await expect(page.getByText("74 / 100", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "重新加载" }).click();
    await expect(search).toHaveValue("  DEMO PROJECT 74  ");
    await expect(rows).toHaveCount(1);
    await search.fill("no-match");
    await expect(page.getByText("没有匹配的项目。")).toBeVisible();
    await page.getByRole("button", { name: "清空搜索" }).click();
    await expect(rows).toHaveCount(50);
    await page.getByRole("combobox", { name: "每页条数" }).selectOption("20");
    await expect(rows).toHaveCount(20);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test("删除最后一页唯一项目后收敛页码，保留每页条数", async ({ page }) => {
  await mockApp(page, 21);
  await page.goto(`${webUrl}/demos`);
  await page.getByRole("button", { name: "下一页" }).click();
  await page.getByRole("button", { name: "下一页" }).click();
  const row = page.locator("tbody tr");
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByLabel(/输入项目标识/).fill("00020");
  await page.getByRole("button", { name: "永久删除" }).click();
  await expect(page.getByText("第 2 / 2 页")).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(10);
  await expect(page.getByText("20 / 100", { exact: true })).toBeVisible();
});

for (const fail of [false, true]) {
  test(`首页准确链接复制${fail ? "失败支持手动复制" : "成功"}`, async ({ page }) => {
    await mockApp(page, 1, fail);
    await page.goto(`${webUrl}/demos`);
    const row = page.locator("tbody tr").first();
    await expect(row.getByRole("link", { name: "index.html", exact: true })).toHaveAttribute(
      "href",
      base.homepage.url,
    );
    await row.getByRole("button", { name: "复制链接和密码" }).click();
    if (fail)
      await expect(row.getByRole("textbox", { name: "手动复制内容" })).toHaveValue(
        `链接：${base.homepage.url}\n密码：Abcd2345`,
      );
    else
      await expect(page.locator("html")).toHaveAttribute(
        "data-copied",
        `链接：${base.homepage.url}\n密码：Abcd2345`,
      );
    await expect(row.getByText("分享密码请到详情获取")).toHaveCount(0);
  });
}

for (const width of [1065, 375]) {
  test(`首页选择保存、刷新保持、恢复自动 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1026 });
    await mockApp(page, 1);
    await page.goto(`${webUrl}/demos/abc12`);
    const select = page.getByRole("combobox", { name: "首页文件" });
    await expect(select.locator("option")).toHaveCount(3);
    await select.selectOption(paths[1] ?? "");
    await page.getByRole("button", { name: "保存首页" }).click();
    await expect(page.locator("#project-homepage").getByRole("status")).toHaveText("首页已保存。");
    await expect(page.getByText(/当前首页：中文目录/)).toBeVisible();
    await page.reload();
    await expect(select).toHaveValue(paths[1] ?? "");
    await page.screenshot({
      path: `/tmp/html-share-homepage-after-${width}-${test.info().project.name}.png`,
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await select.selectOption("");
    await page.getByRole("button", { name: "保存首页" }).click();
    await expect(page.locator("#project-homepage").getByRole("status")).toHaveText(
      "已恢复自动识别。",
    );
    await expect(page.getByText("当前首页：index.html（自动识别）")).toBeVisible();
  });
}

test("首页保存错误保留选择并允许重试", async ({ page }) => {
  await mockApp(page, 1);
  await page.goto(`${webUrl}/demos/abc12`);
  await page.route("**/api/projects/abc12/homepage", (route) =>
    route.fulfill({ status: 409, json: { error: "homepage_file_changed" } }),
  );
  await page.getByRole("combobox", { name: "首页文件" }).selectOption(paths[1] ?? "");
  await page.getByRole("button", { name: "保存首页" }).click();
  await expect(page.locator("#project-homepage").getByRole("alert")).toHaveText(
    "文件集合已变化，请重新加载后选择。",
  );
  await expect(page.getByRole("combobox", { name: "首页文件" })).toHaveValue(paths[1] ?? "");
  await expect(page.getByRole("button", { name: "保存首页" })).toBeEnabled();
});

test("刷新失败与重试仍保留搜索、每页条数和页码", async ({ page }) => {
  await mockApp(page, 23);
  await page.goto(`${webUrl}/demos`);
  const search = page.getByRole("searchbox", { name: "搜索项目名" });
  await search.fill("Demo project");
  await page.getByRole("combobox", { name: "每页条数" }).selectOption("20");
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  let failed = false;
  await page.route("**/api/projects", async (route) => {
    if (!failed) {
      failed = true;
      await route.fulfill({ status: 503, json: { error: "unavailable" } });
    } else await route.fallback();
  });
  await page.getByRole("button", { name: "重新加载" }).click();
  await expect(page.getByText("当前展示上次加载的数据；重试将保留搜索和分页。")).toBeVisible();
  await expect(search).toHaveValue("Demo project");
  await expect(page.getByRole("combobox", { name: "每页条数" })).toHaveValue("20");
  await expect(page.getByText("第 2 / 2 页")).toBeVisible();
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByText("当前展示上次加载的数据；重试将保留搜索和分页。")).toHaveCount(0);
  await expect(search).toHaveValue("Demo project");
  await expect(page.getByRole("combobox", { name: "每页条数" })).toHaveValue("20");
  await expect(page.getByText("第 2 / 2 页")).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(2);
});
