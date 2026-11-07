import { expect, test } from "@playwright/test";
import { files, mockDemoDetail, project, webUrl } from "./demo-detail.fixture";

test.beforeEach(({ page }) => mockDemoDetail(page));

for (const width of [1466, 900, 375]) {
  test(`设置行优先于单文件清单，${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 827 });
    await page.route("**/api/projects/abc12", (route) =>
      route.fulfill({
        json: {
          csrfToken: "test-only",
          project: { ...project, fileCount: 1 },
          files: files.slice(0, 1),
        },
      }),
    );
    await page.goto(`${webUrl}/demos/abc12`);

    const list = page.getByRole("region", { name: "全部文件（1）" });
    const settings = page.getByRole("region", { name: "项目设置" });
    const home = settings.getByRole("region", { name: "项目首页" });
    const access = settings.getByRole("region", { name: "访问方式" });
    const sharing = settings.getByRole("region", { name: "广场共享" });
    await expect(sharing.getByRole("button", { name: "发布到广场" })).toBeVisible();
    const [listBox, settingsBox, homeBox, accessBox, sharingBox] = await Promise.all(
      [list, settings, home, access, sharing].map((area) => area.boundingBox()),
    );
    if (!listBox || !settingsBox || !homeBox || !accessBox || !sharingBox)
      throw new Error("详情布局缺少可见区域");

    expect(listBox.y).toBeGreaterThan(settingsBox.y + settingsBox.height);
    expect(listBox.width).toBeCloseTo(settingsBox.width, 0);
    expect(homeBox.x).toBe(accessBox.x);
    expect(accessBox.x).toBe(sharingBox.x);
    expect(accessBox.y).toBeGreaterThanOrEqual(homeBox.y + homeBox.height);
    expect(sharingBox.y).toBeGreaterThanOrEqual(accessBox.y + accessBox.height);
    const homeTitle = await home.getByRole("heading").boundingBox();
    const homeField = await home.getByRole("combobox").boundingBox();
    if (!homeTitle || !homeField) throw new Error("首页设置控件不可见");
    if (width >= 768) expect(homeField.x).toBeGreaterThan(homeTitle.x);
    else expect(homeField.x).toBe(homeTitle.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

for (const width of [1466, 900, 375]) {
  test(`长文件清单保留原有设置锚点，${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 827 });
    const longList = Array.from({ length: 30 }, (_, index) => ({
      relativePath: `file-${index}.html`,
      size: 128,
      url: `http://demo.localhost:3001/abc12/file-${index}.html`,
    }));
    await page.route("**/api/projects/abc12", (route) =>
      route.fulfill({
        json: {
          csrfToken: "test-only",
          project: { ...project, fileCount: longList.length },
          files: longList,
        },
      }),
    );
    await page.goto(`${webUrl}/demos/abc12`);
    for (const [anchor, title] of [
      ["project-settings", "项目设置"],
      ["project-homepage", "项目首页"],
      ["project-square", "广场共享"],
    ]) {
      const url = `${webUrl}/demos/abc12#${anchor}`;
      const heading = page.getByRole("heading", { name: title, exact: true });
      await page.goto("about:blank");
      await page.goto(url);
      await expect(page).toHaveURL(url);
      await expect(heading).toBeInViewport();
      await page.reload();
      await expect(page).toHaveURL(url);
      await expect(heading).toBeInViewport();
    }
  });
}

test("访问在新标签打开已保存首页，保存后跟随新入口", async ({ page }) => {
  const [, original, replacement] = files;
  if (!original || !replacement) throw new Error("首页用例缺少 HTML 文件");
  let homepage = original;
  let refreshUnavailable = false;
  await page.route("**/api/projects/abc12", (route) =>
    refreshUnavailable
      ? route.fulfill({ status: 503 })
      : route.fulfill({
          json: {
            csrfToken: "test-only",
            project: {
              ...project,
              homepage: { path: homepage.relativePath, url: homepage.url, source: "manual" },
            },
            files,
          },
        }),
  );
  await page.route("**/api/projects/abc12/homepage", (route) => {
    homepage = replacement;
    refreshUnavailable = true;
    return route.fulfill({ json: {} });
  });
  await page
    .context()
    .route("http://demo.localhost:3001/abc12/**", (route) =>
      route.fulfill({ body: "<h1>Demo</h1>", contentType: "text/html" }),
    );
  await page.goto(`${webUrl}/demos/abc12`);
  const visit = page.getByRole("link", { name: "访问（在新标签页打开）" });
  await expect(visit).toHaveAttribute("href", homepage.url);
  const popupPromise = page.waitForEvent("popup");
  await visit.click();
  const popup = await popupPromise;
  await popup.waitForURL(homepage.url);
  await expect(page).toHaveURL(`${webUrl}/demos/abc12`);
  await popup.close();

  await page.getByRole("combobox", { name: "首页文件" }).selectOption(replacement.relativePath);
  await expect(visit).toHaveAttribute("href", original.url);
  await page.getByRole("button", { name: "保存首页" }).click();
  await expect(page.getByRole("region", { name: "项目首页" }).getByRole("alert")).toHaveText(
    "首页已保存，请重新加载后访问。",
  );
  await expect(visit).toHaveCount(0);
  await expect(page.getByRole("button", { name: "访问", exact: true })).toBeDisabled();
  refreshUnavailable = false;
  await page.getByRole("button", { name: "重新加载" }).click();
  await expect(visit).toHaveAttribute("href", replacement.url);
});

test("没有有效首页时页头可定位到首页控件", async ({ page }) => {
  await page.goto(`${webUrl}/demos/abc12`);
  await expect(page.getByRole("link", { name: "访问（在新标签页打开）" })).toHaveCount(0);
  await page.getByRole("link", { name: "设置首页", exact: true }).click();
  await expect(page).toHaveURL(/#project-homepage-file$/);
  await expect(page.getByRole("combobox", { name: "首页文件" })).toBeInViewport();
});

test("重新加载文件时保留文件关键词", async ({ page }) => {
  await page.goto(`${webUrl}/demos/abc12`);
  const search = page.getByRole("searchbox", { name: "搜索文件名" });
  await search.fill("中文目录");
  await expect(page.getByText("显示 1 / 3 个文件")).toBeVisible();
  await page.getByRole("button", { name: "重新加载" }).click();
  await expect(search).toHaveValue("中文目录");
  await expect(page.getByText("显示 1 / 3 个文件")).toBeVisible();
});
