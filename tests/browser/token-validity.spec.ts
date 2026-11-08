import { expect, test } from "@playwright/test";

const webUrl = process.env.HTML_SHARE_INSTALL_WEB_URL ?? "http://127.0.0.1:53000";
const syntheticToken = {
  id: "permanent-fixture",
  name: "长期连接",
  expiresAt: null,
  createdAt: "2026-11-08T09:00:00.000Z",
  revokedAt: null,
  lastUsedAt: null,
  status: "active",
  tokenSuffix: "t-only",
};
const syntheticValue = "browser-fixture-secret-only";

for (const width of [1280, 375]) {
  test(`${width}px 五档有效期可创建，永久 Token 可吊销`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/auth/current", (route) =>
      route.fulfill({ json: { user: { displayName: "测试用户" }, csrfToken: "fixture" } }),
    );
    await page.route("**/api/csrf", (route) => route.fulfill({ json: { csrfToken: "fixture" } }));
    const submitted: unknown[] = [];
    await page.route("**/api/tokens", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          json: {
            tokens: [
              {
                ...syntheticToken,
                id: "expired-fixture",
                name: "已到期的旧凭证",
                createdAt: "2020-01-01T09:00:00.000Z",
                expiresAt: "2020-01-31T09:00:00.000Z",
              },
            ],
          },
        });
        return;
      }
      const payload = route.request().postDataJSON() as {
        name: string;
        expiresInDays: number | "never";
      };
      submitted.push(payload);
      const token =
        payload.expiresInDays === "never"
          ? syntheticToken
          : {
              ...syntheticToken,
              id: `finite-${payload.expiresInDays}`,
              name: payload.name,
              expiresAt: new Date(
                Date.parse(syntheticToken.createdAt) + payload.expiresInDays * 86_400_000,
              ).toISOString(),
            };
      await route.fulfill({ status: 201, json: { token, value: syntheticValue } });
    });
    await page.route("**/api/tokens/permanent-fixture/revoke", (route) =>
      route.fulfill({ status: 204 }),
    );

    await page.goto(`${webUrl}/tokens`);
    const validity = page.getByRole("combobox", { name: "有效期" });
    await expect(validity).toHaveValue("30");
    await expect(validity.locator("option")).toHaveText([
      "1 天",
      "7 天",
      "15 天",
      "30 天",
      "永久有效",
    ]);
    const name = page.getByRole("textbox", { name: "Token 名称" });
    const create = page.getByRole("button", { name: "创建 Token", exact: true });
    const success = page.getByRole("region", { name: "请立即复制 Token" });
    const list = page.getByRole("region", { name: "已创建的 Token" });
    await expect(list.getByText("已过期").filter({ visible: true })).toBeVisible();
    for (const expiresInDays of [30, 1, 7, 15]) {
      await name.fill(`测试 ${expiresInDays} 天`);
      if (expiresInDays !== 30) await validity.selectOption(String(expiresInDays));
      await create.click();
      await expect(success.getByText(/到期时间/)).toBeVisible();
      expect(submitted.at(-1)).toEqual({ name: `测试 ${expiresInDays} 天`, expiresInDays });
      await success.getByRole("button", { name: "我已保存" }).click();
    }

    await name.fill("长期连接");
    await validity.selectOption("never");
    await expect(validity).toHaveAccessibleDescription(/不会自动过期/);
    await create.click();

    await expect(success.getByText("永久有效")).toBeVisible();
    expect(submitted.at(-1)).toEqual({ name: "长期连接", expiresInDays: "never" });
    await expect(success.getByText(syntheticValue)).toBeVisible();
    await expect(list.getByText("永久有效").filter({ visible: true })).toBeVisible();
    await expect(validity).toHaveValue("30");
    await success.getByRole("button", { name: "我已保存" }).click();
    await expect(page.getByText(syntheticValue)).toHaveCount(0);

    page.once("dialog", (dialog) => dialog.accept());
    const permanentEntry = list
      .locator("tr, article")
      .filter({ hasText: "长期连接", visible: true });
    await permanentEntry.getByRole("button", { name: "吊销" }).click();
    await expect(list.getByText("已吊销").filter({ visible: true })).toBeVisible();
    await expect(list.getByText("永久有效")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  });
}
