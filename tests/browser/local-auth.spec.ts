import { expect, test } from "@playwright/test";

const appApiUrl = process.env.HTML_SHARE_APP_URL ?? "http://app.localhost:3001";
const appWebUrl = process.env.HTML_SHARE_APP_WEB_URL ?? "http://app.localhost:3000";
const demoApiUrl = process.env.HTML_SHARE_DEMO_URL ?? "http://demo.localhost:3001";

test("本地模拟器在管理域和内容域完成授权并保持准确路径", async ({ context, page }) => {
  const tokenName = `Browser validation ${test.info().project.name}-${test.info().parallelIndex}`;
  await page.goto(`${appApiUrl}/auth/login?return_path=/tokens`);
  await expect(page).toHaveURL(`${appWebUrl}/tokens`);
  const authorizationStatus = await page.evaluate(async (url) => {
    const response = await fetch(`${url}/auth/current`, { credentials: "include" });
    return response.status;
  }, appApiUrl);
  expect(authorizationStatus).toBe(200);
  await expect(page.getByRole("heading", { name: "连接你的 Agent" })).toBeVisible();

  await page.getByLabel("Token 名称").fill(tokenName);
  await page.getByRole("button", { name: "创建 Token" }).click();
  await expect(page.getByRole("heading", { name: "请立即复制 Token" })).toBeVisible();
  await page.getByRole("button", { name: "我已保存" }).click();

  const tokenRow = page.locator("tr").filter({ hasText: tokenName });
  await expect(tokenRow).toContainText("可用");
  page.once("dialog", (dialog) => dialog.accept());
  await tokenRow.getByRole("button", { name: "吊销" }).click();
  await expect(tokenRow).toContainText("已吊销");

  const contentPage = await context.newPage();
  await contentPage.goto(
    `${demoApiUrl}/auth/content-login?return_path=${encodeURIComponent("/abc12/index.html")}`,
  );
  await expect(contentPage).toHaveURL(`${demoApiUrl}/abc12/index.html`);
  await expect(contentPage.locator("body")).toContainText("Not found");
});
