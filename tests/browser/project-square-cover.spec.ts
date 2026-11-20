import { expect, test } from "@playwright/test";
import { mockSquare, squareWebUrl } from "./project-square.fixture";

const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS2kAAAAASUVORK5CYII=",
  "base64",
);

for (const [width, columns] of [
  [1440, 3],
  [726, 2],
  [375, 1],
]) {
  test(`首页封面布局和降级保持项目入口，${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await mockSquare(page);
    const ready = "/api/square/projects/abc0/cover/ready";
    const missing = "/api/square/projects/abc2/cover/missing";
    state.projects[0].cover = { status: "ready", path: ready };
    state.projects[2].cover = { status: "ready", path: missing };
    await page.route(`**${ready}`, (route) =>
      route.fulfill({
        body: image,
        contentType: "image/png",
        headers: {
          "access-control-allow-origin": squareWebUrl,
          "access-control-allow-credentials": "true",
        },
      }),
    );
    await page.route(`**${missing}`, (route) => route.fulfill({ status: 404 }));
    await page.goto(`${squareWebUrl}/square`);

    const list = page.getByRole("list", { name: "项目卡片" });
    await expect(list.getByRole("listitem")).toHaveCount(10);
    expect(await list.evaluate((el) => Number(getComputedStyle(el).columnCount))).toBe(columns);
    const [first, second, third, fourth] = await list.getByRole("article").all();
    await expect(first.getByRole("link", { name: /^打开：/ })).toHaveAttribute(
      "href",
      state.projects[0].homepage.url,
    );
    await expect.poll(() => first.locator("img").evaluate((el) => el.naturalWidth)).toBe(1);
    await expect(second.getByText("暂无首页预览")).toBeVisible();
    await expect(second.getByText("从项目内容选择文件")).toBeVisible();
    await third.scrollIntoViewIfNeeded();
    await expect(third.getByText("预览暂不可用")).toBeVisible();
    await expect(third.getByRole("link", { name: "查看内容" })).toBeVisible();
    await expect(fourth.getByText("预览暂不可用")).toBeVisible();
    await expect(fourth.getByRole("link", { name: "查看内容" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
