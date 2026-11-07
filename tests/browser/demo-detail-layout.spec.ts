import { expect, test } from "@playwright/test";
import { files, mockDemoDetail, project, webUrl } from "./demo-detail.fixture";

test.beforeEach(({ page }) => mockDemoDetail(page));

for (const width of [1466, 900, 375]) {
  test(`单文件详情中的设置卡片按屏宽排列，${width}px`, async ({ page }) => {
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

    expect(settingsBox.y).toBeGreaterThan(listBox.y + listBox.height);
    expect(listBox.width).toBeCloseTo(settingsBox.width, 0);
    if (width >= 1024) {
      expect(homeBox.y).toBe(accessBox.y);
      expect(homeBox.y).toBe(sharingBox.y);
      expect(homeBox.x).toBeLessThan(accessBox.x);
      expect(accessBox.x).toBeLessThan(sharingBox.x);
      await expect(sharing.getByRole("heading", { name: "广场共享" })).toBeInViewport();
    } else if (width >= 768) {
      expect(homeBox.y).toBe(accessBox.y);
      expect(sharingBox.y).toBeGreaterThan(accessBox.y + accessBox.height);
      expect(sharingBox.width).toBeCloseTo(settingsBox.width, 0);
    } else {
      expect(homeBox.x).toBe(accessBox.x);
      expect(accessBox.x).toBe(sharingBox.x);
      expect(accessBox.y).toBeGreaterThan(homeBox.y + homeBox.height);
      expect(sharingBox.y).toBeGreaterThan(accessBox.y + accessBox.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

for (const width of [1466, 900, 375]) {
  test(`长文件清单可从页头和原有锚点直达设置，${width}px`, async ({ page }) => {
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
    const settings = page.getByRole("heading", { name: "项目设置", exact: true });
    await expect(settings).not.toBeInViewport();
    const settingsLink = page.getByRole("link", { name: "项目设置", exact: true });
    await settingsLink.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#project-settings$/);
    await expect(settings).toBeInViewport();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("combobox", { name: "首页文件" })).toBeFocused();

    for (const [anchor, title] of [
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
