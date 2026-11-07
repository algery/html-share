import { expect, test } from "@playwright/test";

import { mockSquare, squareWebUrl } from "./project-square.fixture.js";

test("在手机宽度组合创建者与项目名，修改筛选回到第一页并可清空", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const state = await mockSquare(page);
  state.projects[0].creatorDisplayName = "张三";
  state.projects[1].creatorDisplayName = "张三";
  await page.goto(`${squareWebUrl}/square`);
  await expect(page.getByText("共 24 个可见项目")).toBeVisible();
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByText("第 2 / 3 页")).toBeVisible();

  const creator = page.getByRole("searchbox", { name: "搜索创建者" });
  const name = page.getByRole("searchbox", { name: "搜索项目名" });
  await creator.fill(" 张三 ");
  await expect(page.getByText("共 2 个匹配项目")).toBeVisible();
  expect(new URLSearchParams(state.listQueries.at(-1)).get("page")).toBe("1");
  expect(new URLSearchParams(state.listQueries.at(-1)).get("creator")).toBe("张三");
  await name.fill("演示 2");
  await expect(page.getByText("共 1 个匹配项目")).toBeVisible();
  await name.fill("没有项目");
  await expect(page.getByText("没有匹配的项目。")).toBeVisible();
  await page.getByRole("button", { name: "清空搜索" }).click();
  await expect(creator).toHaveValue("");
  await expect(name).toHaveValue("");
  await expect(page.getByText("共 24 个可见项目")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
