/* global document, innerWidth */
import { expect } from "@playwright/test";
import { join } from "node:path";

export const webUrl = "http://127.0.0.1:55500";
export const apiUrl = "http://127.0.0.1:55100";

export async function signedContext(browser, cookie, secrets) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(10000);
  const separator = cookie.indexOf("=");
  await context.addCookies([
    {
      name: cookie.slice(0, separator),
      value: cookie.slice(separator + 1),
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  secrets.add(cookie.slice(separator + 1));
  const ownerRequests = [];
  const errors = [];
  let leakedConsole = false;
  context.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/projects"))
      ownerRequests.push(request.method());
  });
  context.on("page", (page) => {
    page.on("pageerror", () => errors.push("pageerror"));
    page.on("console", (message) => {
      if ([...secrets].filter(Boolean).some((secret) => message.text().includes(secret)))
        leakedConsole = true;
    });
  });
  return {
    context,
    page: await context.newPage(),
    ownerRequests,
    errors,
    consoleSafe: () => !leakedConsole,
  };
}

export async function snapshot(page, check, directory, prefix, name) {
  check(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    `${name}: viewport does not overflow`,
  );
  for (const table of await page.locator("table").filter({ visible: true }).all()) {
    check(
      await table.evaluate(
        (element) => element.parentElement.scrollWidth <= element.parentElement.clientWidth,
      ),
      `${name}: table fits its container`,
    );
  }
  for (const button of await page.getByRole("button").filter({ visible: true }).all()) {
    check(
      await button.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      `${name}: button text fits`,
    );
  }
  const path = join(directory, `live-${prefix}-${name}.png`);
  await page.screenshot({
    path,
    fullPage: true,
    animations: "disabled",
    mask: [page.locator("section[aria-labelledby=access-title] code")],
  });
  return path;
}

export async function touchTargets(panel, check) {
  for (const button of await panel.getByRole("button", { name: /^(展开|收起|移除)/ }).all()) {
    const box = await button.boundingBox();
    check(
      box !== null && box.width >= 40 && box.height >= 40,
      "Directory expand/remove targets are at least 40 × 40 CSS pixels",
    );
  }
}

export async function squareList(page, count) {
  await page.goto(`${webUrl}/square`);
  await expect(page.getByText(`共 ${count} 个可见项目`, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "项目广场", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
}

export async function readonlyDetail(page, key, check, secret) {
  const pending = page.waitForResponse(
    (response) => response.url() === `${apiUrl}/api/square/projects/${key}`,
  );
  await page.goto(`${webUrl}/square/${key}`);
  const response = await pending;
  check(response.status() === 200, "Real read-only detail API succeeds");
  check(
    response.headers()["cache-control"] === "private, no-store",
    "Read-only response disables shared cache",
  );
  const body = await response.json();
  const allowed = [
    "projectId",
    "displayName",
    "creatorDisplayName",
    "updatedAt",
    "fileCount",
    "totalSize",
    "homepage",
  ];
  check(
    Object.keys(body).sort().join(",") === "files,project",
    "Read-only top-level whitelist is exact",
  );
  check(
    Object.keys(body.project).every((key) => allowed.includes(key)),
    "Read-only project contains only allowed metadata",
  );
  check(
    body.files.every((file) => Object.keys(file).sort().join(",") === "relativePath,size,url"),
    "Read-only file whitelist excludes storage keys and revisions",
  );
  check(!JSON.stringify(body).includes(secret), "Read-only response excludes project password");
  await expect(page.getByRole("heading", { name: "全部文件（3）" })).toBeVisible();
  await expect(page.getByRole("button", { name: /删除|复制|保存|密码|设置首页|共享/ })).toHaveCount(
    0,
  );
  check(
    !(await page.locator("body").innerText()).includes(secret),
    "Read-only page excludes project password",
  );
  for (const file of body.files) {
    await expect(page.getByRole("link", { name: file.url, exact: true })).toHaveAttribute(
      "href",
      file.url,
    );
  }
  return body;
}

export async function saveScope(page, check, button) {
  const pending = page.waitForResponse(
    (response) => response.url().endsWith("/square") && response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: button, exact: true }).click();
  const response = await pending;
  check(response.status() === 200, `Real browser ${button} write succeeds`);
  return response.json();
}

export async function openContent(context, page, href, check) {
  const pending = context.waitForEvent("page");
  await page.locator(`a[href="${href}"]`).first().click();
  const content = await pending;
  try {
    await expect(content.getByRole("heading", { name: "version phase26" })).toBeVisible();
    check(
      new URL(content.url()).pathname.endsWith("/nested/%E6%B5%8B%E8%AF%95%20file.html"),
      "Real content preserves encoded nested path",
    );
  } finally {
    await content.close();
  }
}
