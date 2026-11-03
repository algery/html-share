import { expect, test, type Page } from "@playwright/test";

const webUrl = process.env.HTML_SHARE_DETAIL_WEB_URL ?? "http://localhost:3000";
const url = "http://demo.localhost:3001/abc12/index.html";
const latestUrl = "http://demo.localhost:3001/abc12/new.html";
const password = "Abcd2345";

async function setup(page: Page, { fail = false, organization = false, promiseApi = true } = {}) {
  const project = {
    accessMode: organization ? "organization" : "password",
    projectId: "abc12",
    displayName: "分享演示",
    createdAt: "2026-11-03T00:00:00Z",
    updatedAt: "2026-11-03T00:00:00Z",
    fileCount: 1,
    totalSize: 10,
    homepage: { path: "index.html", url, source: "automatic", configuredPath: null },
  };
  await page.addInitScript(
    ({ fail, promiseApi }) => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            if (fail) throw new Error("denied");
            document.documentElement.dataset["copied"] = text;
          },
          ...(promiseApi
            ? {
                write: async (items: ClipboardItem[]) => {
                  document.documentElement.dataset["writeStarted"] = "yes";
                  const item = items[0];
                  if (!item) throw new Error("no clipboard item");
                  const blob = await item.getType("text/plain");
                  if (fail) throw new Error("denied");
                  document.documentElement.dataset["copied"] = await blob.text();
                },
              }
            : {}),
        },
      });
    },
    { fail, promiseApi },
  );
  await page.route("**/auth/current", (route) =>
    route.fulfill({ json: { user: { displayName: "测试用户" }, csrfToken: "test" } }),
  );
  await page.route("**/api/projects", (route) =>
    route.fulfill({
      json: {
        projects: [project],
        csrfToken: "test",
        quota: {
          projectCount: 1,
          projectLimit: 100,
          storageBytes: 10,
          storageLimitBytes: 2147483648,
        },
      },
    }),
  );
  return project;
}

for (const width of [1065, 375]) {
  for (const promiseApi of [true, false]) {
    test(`列表一键复制最新链接和密码 ${width}px ${promiseApi ? "Promise剪贴板" : "writeText回退"}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1026 });
      const project = await setup(page, { promiseApi });
      let reads = 0;
      await page.route("**/api/projects/abc12", (route) => {
        reads++;
        return route.fulfill({
          json: {
            project: {
              ...project,
              homepage: { ...project.homepage, url: latestUrl },
              passwordStatus: "available",
              accessPassword: password,
            },
          },
        });
      });
      await page.goto(`${webUrl}/demos`);
      const button = page.getByRole("button", { name: "复制链接和密码" }).filter({ visible: true });
      await expect(button).toBeVisible();
      expect(reads).toBe(0);
      await button.click();
      await expect(page.locator("html")).toHaveAttribute(
        "data-copied",
        `链接：${latestUrl}\n密码：${password}`,
      );
      await expect(page).toHaveURL(`${webUrl}/demos`);
      expect(reads).toBe(1);
      await expect(
        page.getByText("已复制分享信息", { exact: true }).filter({ visible: true }),
      ).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const storage = await page.evaluate(async () => ({
        local: Object.values(localStorage),
        session: Object.values(sessionStorage),
        db: (await indexedDB.databases()).map((db) => db.name),
      }));
      expect(storage.local).toEqual([]);
      expect(storage.session).toEqual([]);
      expect(storage.db).toEqual([]);
      await page.screenshot({
        path: `/tmp/html-share-list-share-${width}-${promiseApi}-${test.info().project.name}.png`,
        fullPage: true,
      });
      await page.route("**/api/projects/abc12", (route) =>
        route.fulfill({
          json: {
            project: { ...project, passwordStatus: "available", accessPassword: "Wxyz6789" },
          },
        }),
      );
      await button.click();
      await expect(page.locator("html")).toHaveAttribute(
        "data-copied",
        `链接：${url}\n密码：Wxyz6789`,
      );
    });
  }
}

test("组织项目不读取详情直接复制URL", async ({ page }) => {
  await setup(page, { organization: true });
  let reads = 0;
  await page.route("**/api/projects/abc12", (route) => {
    reads++;
    return route.abort();
  });
  await page.goto(`${webUrl}/demos`);
  await page.getByRole("button", { name: "复制首页" }).filter({ visible: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-copied", url);
  expect(reads).toBe(0);
});

test("密码模式已关闭时只复制最新URL", async ({ page }) => {
  const project = await setup(page);
  await page.route("**/api/projects/abc12", (route) =>
    route.fulfill({
      json: { project: { ...project, accessMode: "organization", homepage: { url: latestUrl } } },
    }),
  );
  await page.goto(`${webUrl}/demos`);
  await page.getByRole("button", { name: "复制链接和密码" }).filter({ visible: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-copied", latestUrl);
  await expect(
    page.getByText("已复制分享信息", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(page.getByText("已复制链接和密码", { exact: true })).toHaveCount(0);
});

for (const kind of ["legacy", "homepage", "401", "404", "503", "network"]) {
  test(`分享读取 ${kind} 不复制不完整信息并可重试`, async ({ page }) => {
    const project = await setup(page);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/api/projects/abc12", (route) =>
      kind === "network"
        ? route.abort()
        : ["401", "404", "503"].includes(kind)
          ? route.fulfill({ status: Number(kind), json: { error: "unavailable" } })
          : route.fulfill({
              json: {
                project: {
                  ...project,
                  homepage: kind === "homepage" ? { url: null } : project.homepage,
                  passwordStatus: "unavailable",
                },
              },
            }),
    );
    await page.goto(`${webUrl}/demos`);
    const button = page.getByRole("button", { name: "复制链接和密码" }).filter({ visible: true });
    await button.click();
    const message =
      kind === "legacy"
        ? "历史密码无法读取，请到详情重新生成密码。"
        : kind === "homepage"
          ? "首页已变化，请到详情重新设置首页。"
          : kind === "401"
            ? "登录已过期，请重新登录。"
            : kind === "404"
              ? "项目已删除或无法访问，请刷新列表。"
              : "获取分享信息失败，请重试。";
    await expect(page.getByText(message).filter({ visible: true })).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-copied");
    await expect(page.getByRole("textbox", { name: "手动复制内容" })).toHaveCount(0);
    await expect(button).toBeEnabled();
    expect(pageErrors).toEqual([]);
  });
}

test("剪贴板失败在列表提供完整两行手动复制", async ({ page }) => {
  const project = await setup(page, { fail: true });
  await page.route("**/api/projects/abc12", (route) =>
    route.fulfill({
      json: { project: { ...project, passwordStatus: "available", accessPassword: password } },
    }),
  );
  await page.goto(`${webUrl}/demos`);
  await page.getByRole("button", { name: "复制链接和密码" }).filter({ visible: true }).click();
  await expect(page.getByRole("textbox", { name: "手动复制内容" })).toHaveValue(
    `链接：${url}\n密码：${password}`,
  );
  await expect(page).toHaveURL(`${webUrl}/demos`);
});

test("异步读取前已发起剪贴板写入且禁止重复点击", async ({ page }) => {
  const project = await setup(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  await page.route("**/api/projects/abc12", async (route) => {
    reads++;
    await held;
    await route.fulfill({
      json: { project: { ...project, passwordStatus: "available", accessPassword: password } },
    });
  });
  await page.goto(`${webUrl}/demos`);
  await page.getByRole("button", { name: "复制链接和密码" }).filter({ visible: true }).click();
  await expect(
    page.getByRole("button", { name: "正在复制…" }).filter({ visible: true }),
  ).toBeDisabled();
  await expect(page.locator("html")).toHaveAttribute("data-write-started", "yes");
  expect(reads).toBe(1);
  release();
  await expect(page.locator("html")).toHaveAttribute(
    "data-copied",
    `链接：${url}\n密码：${password}`,
  );
});
