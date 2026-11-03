import { expect, test, type Page } from "@playwright/test";

const webUrl = process.env.HTML_SHARE_DETAIL_WEB_URL ?? "http://localhost:3000";
const baseProject = {
  accessMode: "organization",
  passwordStatus: "disabled",
  displayName: "入口设置演示",
  projectId: "abc12",
  fileCount: 2,
  totalSize: 12,
  createdAt: "2026-11-03T00:00:00Z",
  updatedAt: "2026-11-03T00:00:00Z",
};

async function mock(page: Page, source = "ambiguous", configuredPath: string | null = null) {
  const homepage = { source, configuredPath, path: null, url: null };
  const paths = source === "none" ? ["app.js"] : ["a.html", "b.html"];
  await page.route("**/auth/current", (route) =>
    route.fulfill({ json: { user: { displayName: "测试用户" }, csrfToken: "test-only" } }),
  );
  await page.route("**/api/projects", (route) =>
    route.fulfill({
      json: {
        csrfToken: "test-only",
        projects: [{ ...baseProject, homepage }],
        quota: {
          projectCount: 1,
          projectLimit: 100,
          storageBytes: 12,
          storageLimitBytes: 2147483648,
        },
      },
    }),
  );
  await page.route("**/api/projects/abc12", (route) =>
    route.fulfill({
      json: {
        csrfToken: "test-only",
        project: { ...baseProject, homepage },
        files: paths.map((relativePath) => ({
          relativePath,
          size: 6,
          url: `http://demo.localhost:3001/abc12/${relativePath}`,
        })),
      },
    }),
  );
}

for (const [source, label] of [
  ["ambiguous", "尚未指定首页"],
  ["none", "暂无 HTML 文件"],
  ["missing", "原首页已移除"],
]) {
  test(`首页 ${source} 不提供无效链接，设置引导可达`, async ({ page }) => {
    await mock(page, source, source === "missing" ? "old.html" : null);
    await page.goto(`${webUrl}/demos`);
    const row = page.locator("tbody tr");
    await expect(row.getByText(label ?? "")).toBeVisible();
    await expect(row.getByRole("button", { name: "复制首页" })).toHaveCount(0);
    await row.getByRole("link", { name: "设置首页" }).click();
    await expect(page).toHaveURL(`${webUrl}/demos/abc12#project-homepage`);
    const section = page.locator("#project-homepage");
    await expect(section).toBeVisible();
    if (source === "missing") {
      await expect(section.getByText("原指定首页已被移除，请重新设置。")).toBeVisible();
      await expect(section.getByRole("combobox")).toHaveValue("old.html");
      await expect(section.getByRole("button", { name: "保存首页" })).toBeDisabled();
      await section.getByRole("combobox").selectOption("a.html");
      await expect(section.getByRole("button", { name: "保存首页" })).toBeEnabled();
    }
    if (source === "none")
      await expect(section.getByRole("combobox").locator("option")).toHaveCount(1);
  });
}

for (const status of [401, 403, 503, 0]) {
  test(`首页保存 ${status || "网络中断"} 不丢失选择，可重试`, async ({ page }) => {
    await mock(page);
    await page.goto(`${webUrl}/demos/abc12`);
    await page.route("**/api/projects/abc12/homepage", (route) =>
      status === 0 ? route.abort() : route.fulfill({ status, json: { error: "unavailable" } }),
    );
    const section = page.locator("#project-homepage");
    await section.getByRole("combobox").selectOption("b.html");
    await section.getByRole("button", { name: "保存首页" }).click();
    await expect(section.getByRole("alert")).toBeVisible();
    await expect(section.getByRole("combobox")).toHaveValue("b.html");
    await expect(section.getByRole("button", { name: "保存首页" })).toBeEnabled();
  });
}

test("首页提交中禁止重复操作", async ({ page }) => {
  await mock(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  await page.route("**/api/projects/abc12/homepage", async (route) => {
    writes++;
    await held;
    await route.fulfill({ status: 503, json: { error: "unavailable" } });
  });
  await page.goto(`${webUrl}/demos/abc12`);
  const section = page.locator("#project-homepage");
  await section.getByRole("combobox").selectOption("b.html");
  await section.getByRole("button", { name: "保存首页" }).click();
  await expect(section.getByRole("button", { name: "正在保存…" })).toBeDisabled();
  await expect(section.getByRole("combobox")).toBeDisabled();
  expect(writes).toBe(1);
  release();
  await expect(section.getByRole("button", { name: "保存首页" })).toBeEnabled();
});
