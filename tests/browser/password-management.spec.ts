import { expect, test, type Page, type Route } from "@playwright/test";

const webUrl = process.env.HTML_SHARE_DETAIL_WEB_URL ?? "http://localhost:3000";
const fileUrl =
  "http://demo.localhost:3001/abc12/%E4%B8%AD%E6%96%87%E7%9B%AE%E5%BD%95/%E9%A1%B5%E9%9D%A2%20file.html";
const file = { relativePath: "中文目录/页面 file.html", size: 128, url: fileUrl };

interface MockAccess {
  accessMode: "organization" | "password";
  accessPassword?: string;
  passwordStatus: "available" | "disabled" | "unavailable";
}

function project(access: MockAccess) {
  return {
    ...access,
    createdAt: "2026-09-10T00:00:00Z",
    displayName: "访问管理演示",
    fileCount: 1,
    projectId: "abc12",
    totalSize: 128,
    updatedAt: "2026-09-10T01:00:00Z",
  };
}

async function mockClipboard(page: Page, fail = false) {
  await page.addInitScript((shouldFail) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          if (shouldFail) throw new Error("permission denied");
          document.documentElement.dataset["copied"] = value;
        },
      },
    });
  }, fail);
}

async function mockProject(page: Page, initial: MockAccess, onWrite?: (route: Route) => void) {
  let access = initial;
  await page.route("**/auth/current", (route) =>
    route.fulfill({ json: { csrfToken: "csrf-test", user: { displayName: "测试用户" } } }),
  );
  await page.route("**/api/projects/abc12/password-access", async (route) => {
    if (onWrite !== undefined) return onWrite(route);
    const input = JSON.parse(route.request().postData() ?? "{}") as { action?: string };
    if (input.action === "enable") {
      access = { accessMode: "password", accessPassword: "Abcd2345", passwordStatus: "available" };
    } else if (input.action === "regenerate") {
      access = { accessMode: "password", accessPassword: "Wxyz6789", passwordStatus: "available" };
    } else {
      access = { accessMode: "organization", passwordStatus: "disabled" };
    }
    await route.fulfill({ json: { ...access, status: "updated" } });
  });
  await page.route("**/api/projects/abc12", (route) =>
    route.fulfill({ json: { csrfToken: "csrf-test", files: [file], project: project(access) } }),
  );
}

for (const width of [1280, 375]) {
  test(`开启、常显、重新生成、关闭与组合复制，${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockClipboard(page);
    await mockProject(page, { accessMode: "organization", passwordStatus: "disabled" });
    await page.goto(`${webUrl}/demos/abc12`);
    await expect(page.getByText("组织访问", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "开启密码访问" }).click();
    await expect(page.getByRole("dialog")).toContainText("项目文件、链接和当前版本保持不变");
    await page.getByRole("button", { name: "确认开启" }).click();
    await expect(page.getByText("Abcd2345", { exact: true })).toBeVisible();
    await expect(page.getByText("已开启密码访问。")).toBeVisible();

    const row = page.getByRole("listitem").filter({ hasText: file.relativePath });
    await row.getByRole("button", { name: "复制链接" }).click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-copied",
      `链接：${fileUrl}\n密码：Abcd2345`,
    );
    await page.reload();
    await expect(page.getByText("Abcd2345", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "重新生成密码" }).click();
    await expect(page.getByRole("dialog")).toContainText("旧密码和已发出的密码访问凭证会立即失效");
    await page.getByRole("button", { name: "确认重新生成" }).click();
    await expect(page.getByText("Wxyz6789", { exact: true })).toBeVisible();
    await row.getByRole("button", { name: "复制链接" }).click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-copied",
      `链接：${fileUrl}\n密码：Wxyz6789`,
    );
    await page.screenshot({
      fullPage: true,
      path: `/tmp/html-share-password-management-${width}-${test.info().project.name}.png`,
    });

    await page.getByRole("button", { name: "关闭密码访问" }).click();
    await page.getByRole("button", { name: "确认关闭" }).click();
    await expect(page.getByText("组织访问", { exact: true })).toBeVisible();
    await row.getByRole("button", { name: "复制链接" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-copied", fileUrl);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await page.evaluate(async () => ({
        indexedDb: (await indexedDB.databases()).map((database) => database.name),
        local: Object.values(localStorage),
        session: Object.values(sessionStorage),
      })),
    ).toEqual({ indexedDb: [], local: [], session: [] });
  });
}

test("历史密码明确提示不可显示，重新生成后恢复常显", async ({ page }) => {
  await mockClipboard(page);
  await mockProject(page, { accessMode: "password", passwordStatus: "unavailable" });
  await page.goto(`${webUrl}/demos/abc12`);
  await expect(page.getByText(/历史密码不可显示/)).toBeVisible();
  await expect(page.getByRole("button", { name: "复制链接" })).toBeDisabled();
  await expect(page.getByText("请先重新生成密码")).toBeVisible();
  await page.getByRole("button", { name: "重新生成密码" }).click();
  await page.getByRole("button", { name: "确认重新生成" }).click();
  await expect(page.getByText("Wxyz6789", { exact: true })).toBeVisible();
});

test("冲突后状态不变并可重新提交，确认弹窗支持键盘退出", async ({ page }) => {
  let attempts = 0;
  await mockProject(
    page,
    { accessMode: "organization", passwordStatus: "disabled" },
    async (route) => {
      attempts += 1;
      await route.fulfill(
        attempts === 1
          ? { json: { error: "project_upload_conflict" }, status: 409 }
          : {
              json: {
                accessMode: "password",
                accessPassword: "Abcd2345",
                passwordStatus: "available",
                status: "updated",
              },
            },
      );
    },
  );
  await page.goto(`${webUrl}/demos/abc12`);
  const enableButton = page.getByRole("button", { name: "开启密码访问" });
  await enableButton.click();
  await expect(page.getByRole("button", { name: "取消" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "确认开启" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "取消" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(enableButton).toBeFocused();
  await page.getByRole("button", { name: "开启密码访问" }).click();
  await page.getByRole("button", { name: "确认开启" }).click();
  await expect(
    page.getByText("项目正在发布，请等待发布完成后重试。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("组织访问", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "开启密码访问" }).click();
  await page.getByRole("button", { name: "确认开启" }).click();
  await expect(page.getByText("Abcd2345", { exact: true })).toBeVisible();
});

test("组合复制失败时提供完整两行手动文本", async ({ page }) => {
  await mockClipboard(page, true);
  await mockProject(page, {
    accessMode: "password",
    accessPassword: "Abcd2345",
    passwordStatus: "available",
  });
  await page.goto(`${webUrl}/demos/abc12`);
  await page.getByRole("button", { name: "复制链接" }).click();
  await expect(page.getByRole("textbox", { name: "手动复制内容" })).toHaveValue(
    `链接：${fileUrl}\n密码：Abcd2345`,
  );
});

test("提交期间焦点留在无可操作项的确认弹窗内", async ({ page }) => {
  let release: (() => void) | undefined;
  await mockProject(
    page,
    { accessMode: "organization", passwordStatus: "disabled" },
    async (route) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({
        json: {
          accessMode: "password",
          accessPassword: "Abcd2345",
          passwordStatus: "available",
        },
      });
    },
  );
  await page.goto(`${webUrl}/demos/abc12`);
  await page.getByRole("button", { name: "开启密码访问" }).click();
  await page.getByRole("button", { name: "确认开启" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog).toBeFocused();
  release?.();
  await expect(page.getByText("Abcd2345", { exact: true })).toBeVisible();
});
