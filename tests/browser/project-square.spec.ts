import { expect, test } from "@playwright/test";
import {
  childDepartment,
  department,
  mockSquare,
  squareFiles,
  squareProject,
  squareWebUrl,
  user,
} from "./project-square.fixture";

test("首次选择范围才可确认发布，键盘取消恢复焦点，关闭和重发再次确认", async ({ page }) => {
  const state = await mockSquare(page);
  await page.goto(`${squareWebUrl}/demos`);
  await expect(page.getByRole("link", { name: "项目广场", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "广场设置" }).filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/demos\/abc12#project-square$/);
  const panel = page.getByRole("region", { name: "广场共享" });
  const publish = panel.getByRole("button", { name: "发布到广场" });
  await expect(publish).toBeDisabled();
  await expect(panel.getByRole("radio", { name: "全组织", exact: true })).not.toBeChecked();
  await panel.getByRole("radio", { name: "全组织", exact: true }).check();
  expect(state.putBodies).toHaveLength(0);
  await publish.click();
  await expect(page.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "确认发布", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(publish).toBeFocused();
  expect(state.putBodies).toHaveLength(0);
  await publish.click();
  await page.getByRole("button", { name: "确认发布", exact: true }).click();
  await expect(panel.getByText("已共享", { exact: true })).toBeVisible();
  expect(state.putBodies[0]).toEqual({
    enabled: true,
    settingsVersion: 1,
    audienceType: "organization",
  });
  state.directoryStatus = 503;
  await panel.getByRole("button", { name: "关闭共享", exact: true }).click();
  await expect(panel.getByText("未共享", { exact: true })).toBeVisible();
  expect(state.putBodies[1]).toEqual({ enabled: false, settingsVersion: 2 });
  await publish.click();
  await expect(page.getByRole("dialog")).toContainText("全组织成员");
  expect(state.putBodies).toHaveLength(2);
});

test("树展开、同名路径、部门人员混选、去重移除与409保留草稿", async ({ page }) => {
  const state = await mockSquare(page);
  await page.goto(`${squareWebUrl}/demos/abc12`);
  const panel = page.getByRole("region", { name: "广场共享" });
  await panel.getByRole("radio", { name: "指定部门 / 人员" }).check();
  await expect(panel.getByText("仅显示应用获授权的部门和人员，目录范围不完整。")).toBeVisible();
  await panel
    .getByRole("checkbox", { name: `产品部（含子部门） ${department.path}`, exact: true })
    .check();
  await panel.getByRole("button", { name: "展开产品部" }).click();
  await panel
    .getByRole("checkbox", { name: `产品部（含子部门） ${childDepartment.path}`, exact: true })
    .check();
  await panel.getByRole("searchbox", { name: "搜索部门或姓名" }).fill("张");
  await expect(
    panel.getByRole("checkbox", { name: `产品部（含子部门） ${department.path}`, exact: true }),
  ).toBeChecked();
  await panel.getByRole("checkbox", { name: `张同学 ${user.departmentPaths[0]}` }).check();
  await expect(panel.getByText("已选 3 / 100 项", { exact: true })).toBeVisible();
  await panel
    .getByRole("region", { name: "已选范围" })
    .getByRole("listitem")
    .filter({ hasText: childDepartment.path })
    .getByRole("button", { name: "移除部门：产品部", exact: true })
    .click();
  await expect(panel.getByText("已选 2 / 100 项", { exact: true })).toBeVisible();
  state.putStatus = 409;
  await panel.getByRole("button", { name: "发布到广场" }).click();
  await page.getByRole("button", { name: "确认发布", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("草稿已保留");
  await expect(panel.getByText("未共享", { exact: true })).toBeVisible();
  await expect(panel.getByText("已选 2 / 100 项", { exact: true })).toBeVisible();
  state.settings.settingsVersion = 2;
  await panel.getByRole("button", { name: "重新加载共享设置" }).click();
  await expect(
    panel.getByText("已重新加载共享状态；当前范围草稿已保留，请核对后保存。"),
  ).toBeVisible();
  state.putStatus = 200;
  await panel.getByRole("button", { name: "发布到广场" }).click();
  await page.getByRole("button", { name: "确认发布", exact: true }).click();
  expect(state.putBodies[1]).toEqual({
    enabled: true,
    settingsVersion: 2,
    audienceType: "selected",
    departmentIds: [department.id],
    userIds: [user.id],
  });
  await expect(panel.getByText("已共享", { exact: true })).toBeVisible();
});

test("目录失败可重试，保存失败保旧，关闭不查询目录", async ({ page }) => {
  const state = await mockSquare(page, true);
  state.directoryStatus = 503;
  await page.goto(`${squareWebUrl}/demos/abc12`);
  const panel = page.getByRole("region", { name: "广场共享" });
  await expect(panel.getByRole("alert")).toContainText("组织目录暂不可用");
  await expect(panel.getByText("已选 1 / 100 项", { exact: true })).toBeVisible();
  state.directoryStatus = 200;
  await panel.getByRole("button", { name: "重试目录" }).click();
  await expect(panel.getByRole("checkbox")).toBeChecked();
  await panel.getByRole("searchbox", { name: "搜索部门或姓名" }).fill("张");
  await panel.getByRole("checkbox", { name: `张同学 ${user.departmentPaths[0]}` }).check();
  state.putStatus = 503;
  await panel.getByRole("button", { name: "保存范围" }).click();
  await expect(panel.getByRole("alert")).toContainText("当前设置和草稿已保留");
  await expect(panel.getByText("已共享", { exact: true })).toBeVisible();
  await expect(panel.getByText("已选 2 / 100 项", { exact: true })).toBeVisible();
  state.directoryStatus = 503;
  state.putStatus = 200;
  await panel.getByRole("button", { name: "关闭共享", exact: true }).click();
  await expect(panel.getByText("未共享", { exact: true })).toBeVisible();
  expect(state.putBodies.at(-1)).toEqual({ enabled: false, settingsVersion: 1 });
});

test("广场搜索分页走服务器，缩小页数收敛，刷新失败清空旧条目", async ({ page }) => {
  const state = await mockSquare(page);
  await page.goto(`${squareWebUrl}/square`);
  await expect(page.getByText("共 24 个可见项目", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "项目广场", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByText("第 2 / 3 页")).toBeVisible();
  expect(state.listQueries.at(-1)).toContain("page=2");
  state.projects = state.projects.slice(0, 4);
  await page.getByRole("button", { name: "重新加载" }).click();
  await expect(page.getByText("第 1 / 1 页")).toBeVisible();
  await page.getByRole("searchbox", { name: "搜索项目名" }).fill("  演示 2  ");
  await expect(page.getByText("共 1 个匹配项目")).toBeVisible();
  expect(new URLSearchParams(state.listQueries.at(-1)).get("q")).toBe("演示 2");
  await expect(page.getByText("从项目内容选择文件").filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "设置首页" })).toHaveCount(0);
  await page.getByRole("combobox", { name: "每页条数" }).selectOption("20");
  await expect.poll(() => state.listQueries.at(-1)).toContain("pageSize=20");
  state.listStatus = 503;
  await page.getByRole("button", { name: "重新加载" }).click();
  await expect(page.getByRole("heading", { name: "无法加载广场内容" })).toBeVisible();
  await expect(page.getByRole("link", { name: "项目内容", exact: true })).toHaveCount(0);
  await expect(page.getByRole("searchbox", { name: "搜索项目名" })).toHaveValue("  演示 2  ");
  expect(state.ownerRequests).toHaveLength(0);
});

for (const width of [1440, 1065, 375, 750]) {
  test(`只读列表详情与长路径，无owner请求和管理动作，${width}px${width === 750 ? " 200%" : ""}`, async ({
    page,
  }) => {
    const state = await mockSquare(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${squareWebUrl}/square`);
    if (width === 750)
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2";
      });
    await expect(page.getByText("共 24 个可见项目", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `/tmp/html-share-square-list-${width}-${test.info().project.name}.png`,
      fullPage: true,
    });
    await page
      .getByRole("link", { name: "项目内容", exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: squareProject.displayName, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "项目广场", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    for (const file of squareFiles)
      await expect(page.getByRole("link", { name: file.url, exact: true })).toHaveAttribute(
        "href",
        file.url,
      );
    await expect(
      page.getByRole("button", { name: /删除|复制|保存|密码|设置首页|共享/ }),
    ).toHaveCount(0);
    await page.getByRole("searchbox", { name: "搜索文件名" }).fill(" 中文目录 ");
    await expect(page.getByRole("listitem")).toHaveCount(1);
    await expect(page.getByText("显示 1 / 3 个文件")).toBeVisible();
    expect(state.ownerRequests).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `/tmp/html-share-square-detail-${width}-${test.info().project.name}.png`,
      fullPage: true,
    });
    state.detailStatus = 404;
    await page.getByRole("button", { name: "重新加载" }).click();
    await expect(page.getByRole("heading", { name: "项目不存在或无法访问" })).toBeVisible();
    await expect(page.getByRole("listitem")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: squareProject.displayName, exact: true }),
    ).toHaveCount(0);
  });
}

test("200%阅读与窄屏范围选择无页面溢出", async ({ page }) => {
  await mockSquare(page, true);
  await page.setViewportSize({ width: 750, height: 1200 });
  await page.goto(`${squareWebUrl}/demos/abc12#project-square`);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  const panel = page.getByRole("region", { name: "广场共享" });
  await expect(panel.getByText("已选 1 / 100 项", { exact: true })).toBeVisible();
  await panel.getByRole("searchbox", { name: "搜索部门或姓名" }).fill("张");
  await panel.getByRole("checkbox", { name: `张同学 ${user.departmentPaths[0]}` }).check();
  await expect(panel.getByText("已选 2 / 100 项", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `/tmp/html-share-square-settings-200-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("目录分页保持选择且去重，搜索空状态不删除已选", async ({ page }) => {
  const state = await mockSquare(page, true);
  state.directoryPagination = true;
  await page.goto(`${squareWebUrl}/demos/abc12`);
  const panel = page.getByRole("region", { name: "广场共享" });
  await panel.getByRole("button", { name: "继续加载" }).click();
  await expect(panel.getByRole("checkbox")).toHaveCount(2);
  await expect(
    panel.getByRole("checkbox", { name: `产品部（含子部门） ${department.path}`, exact: true }),
  ).toBeChecked();
  await panel.getByRole("searchbox", { name: "搜索部门或姓名" }).fill("missing");
  await expect(panel.getByText("没有匹配的部门或人员。")).toBeVisible();
  await expect(panel.getByText("已选 1 / 100 项", { exact: true })).toBeVisible();
});

test("100项边界阻止扩大选择，移除后可继续混选", async ({ page }) => {
  const state = await mockSquare(page, true);
  const departments = Array.from({ length: 100 }, (_, index) => ({
    ...department,
    id: `department-${index}`,
    name: `部门 ${index}`,
  }));
  state.settings.departmentIds = departments.map((item) => item.id);
  state.settings.selectedDepartments = departments;
  await page.goto(`${squareWebUrl}/demos/abc12`);
  const panel = page.getByRole("region", { name: "广场共享" });
  await expect(panel.getByText("已选 100 / 100 项", { exact: true })).toBeVisible();
  await panel.getByRole("searchbox", { name: "搜索部门或姓名" }).fill("张");
  const person = panel.getByRole("checkbox", { name: `张同学 ${user.departmentPaths[0]}` });
  await expect(person).toBeDisabled();
  await panel.getByRole("button", { name: "移除部门：部门 0", exact: true }).click();
  await person.check();
  await expect(panel.getByText("已选 100 / 100 项", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "保存范围" }).click();
  await expect(panel.getByText("广场共享已保存。")).toBeVisible();
  expect((state.putBodies[0]?.["departmentIds"] as string[]).length).toBe(99);
  expect(state.putBodies[0]?.["userIds"]).toEqual([user.id]);
});

test("广场空状态和登录过期不残留列表", async ({ page }) => {
  const state = await mockSquare(page);
  state.projects = [];
  await page.goto(`${squareWebUrl}/square`);
  await expect(
    page.getByText("暂无可见项目。创建者共享后，符合范围的项目会出现在这里。"),
  ).toBeVisible();
  await page.getByRole("searchbox", { name: "搜索项目名" }).fill("不存在");
  await expect(page.getByText("没有匹配的项目。")).toBeVisible();
  await page.getByRole("button", { name: "清空搜索" }).click();
  state.listStatus = 401;
  await page.getByRole("button", { name: "重新加载" }).click();
  await expect(page.getByRole("heading", { name: "登录状态已过期" })).toBeVisible();
  await expect(page.getByRole("link", { name: "前往登录" })).toBeVisible();
  expect(state.ownerRequests).toHaveLength(0);
});
