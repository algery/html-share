import assert from "node:assert/strict";

import { chromium, webkit } from "@playwright/test";

import {
  publishAccessFixture,
  responseCookies,
  responseState,
} from "./password-access-fixture.mjs";
import { startPasswordHttps } from "./password-https-harness.mjs";
import {
  assertBuildExcludes,
  buildManagementWeb,
  startManagementWeb,
  stopProcess,
  waitForManagementWeb,
} from "./password-management-web-harness.mjs";
import { createHarness, isolatedConfiguration } from "./password-smoke-support.mjs";

const appUrl = "http://127.0.0.1:55100";
const webUrl = "http://127.0.0.1:55500";
const demoUrl = "https://localhost:55443";
let assertions = 0;
const buildSecrets = new Set();
const check = (condition, message) => {
  assert(condition, message);
  assertions++;
};

const h = await createHarness(isolatedConfiguration(), check, {
  appUrl,
  appWebUrl: webUrl,
  demoUrl,
  passwordAccess: true,
});
let https;
let web;
try {
  https = await startPasswordHttps();
  await buildManagementWeb({ appUrl, check, demoUrl, webUrl });
  web = startManagementWeb({ appUrl, demoUrl, webUrl });
  await waitForManagementWeb(webUrl, check);

  for (const browserType of [chromium, webkit]) {
    await verifyLifecycle(browserType);
  }

  await assertBuildExcludes(
    [
      process.env.PASSWORD_MANAGEMENT_ENCRYPTION_KEY,
      process.env.PASSWORD_RESULT_ENCRYPTION_KEY,
      h.appSessionToken,
      ...buildSecrets,
    ],
    check,
  );
  console.log(
    JSON.stringify({
      assertions,
      browsers: ["chromium", "webkit"],
      realPostgreSql: true,
      realMinio: true,
      realServer: true,
      realWeb: true,
      realWorkerFinalizer: true,
      status: "password-management-smoke-ok",
    }),
  );
} finally {
  if (web) await stopProcess(web);
  if (https) await https.close();
  await h.cleanup();
}

async function verifyLifecycle(browserType) {
  const published = await publishAccessFixture(h, check, { access_mode: undefined });
  check(
    published.result.access_mode === "organization",
    "Skill default remains organization access",
  );
  check(
    published.result.access_password === undefined,
    "Skill default publication returns no password",
  );
  const before = await h.prisma.demoProject.findUniqueOrThrow({
    include: { fileObjects: { orderBy: { relativePath: "asc" } } },
    where: { projectKey: published.result.project_id },
  });
  const browser = await browserType.launch();
  const context = await browser.newContext();
  try {
    await context.addCookies([
      {
        httpOnly: true,
        name: "html_share_app_session",
        sameSite: "Lax",
        url: webUrl,
        value: h.appSessionToken,
      },
    ]);
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(globalThis.navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value) => {
            globalThis.document.documentElement.dataset.copied = value;
          },
        },
      });
    });
    await page.goto(`${webUrl}/demos/${published.result.project_id}`);
    await page.getByText("组织访问", { exact: true }).waitFor();
    await page.getByRole("button", { name: "开启密码访问" }).click();
    await page.getByRole("button", { name: "确认开启" }).click();
    const passwordCode = page
      .locator("code")
      .filter({ hasText: /^[A-Za-z0-9]+$/ })
      .first();
    await passwordCode.waitFor();
    const firstPassword = (await passwordCode.textContent())?.trim();
    check(Boolean(firstPassword), "management Web keeps the enabled password visible");
    buildSecrets.add(firstPassword);
    const enabledProject = await h.prisma.demoProject.findUniqueOrThrow({
      where: { id: before.id },
    });
    check(
      enabledProject.encryptedPassword !== null &&
        !enabledProject.encryptedPassword.includes(firstPassword),
      "database stores an authenticated ciphertext instead of plaintext",
    );
    buildSecrets.add(enabledProject.encryptedPassword);

    const fileRow = page.getByRole("listitem").filter({ hasText: "nested/测试 file.html" });
    const fileLink = await fileRow.getByRole("link").getAttribute("href");
    await fileRow.getByRole("button", { name: "复制链接" }).click();
    check(
      (await page.locator("html").getAttribute("data-copied")) ===
        `链接：${fileLink}\n密码：${firstPassword}`,
      "real Web copies the exact two-line link and password",
    );
    await page.reload();
    await page.getByText(firstPassword, { exact: true }).waitFor();
    check(true, "current password remains visible after a real detail reload");

    const firstGrant = await login(published.targetPath, firstPassword);
    check(firstGrant.status === 200, "enabled password grants external content access");
    const firstGrantCookie = responseCookies(firstGrant);
    check(
      (await https.request(published.targetPath, { headers: { cookie: firstGrantCookie } }))
        .status === 200,
      "enabled password grant reads the exact published path",
    );

    await page.getByRole("button", { name: "重新生成密码" }).click();
    await page.getByRole("button", { name: "确认重新生成" }).click();
    await page.getByText("已重新生成密码，旧密码已失效。", { exact: true }).waitFor();
    const nextPassword = (await passwordCode.textContent())?.trim();
    check(
      Boolean(nextPassword) && nextPassword !== firstPassword,
      "regenerate replaces the visible password",
    );
    buildSecrets.add(nextPassword);
    const regeneratedProject = await h.prisma.demoProject.findUniqueOrThrow({
      where: { id: before.id },
    });
    buildSecrets.add(regeneratedProject.encryptedPassword);
    check(
      (await login(published.targetPath, firstPassword)).status === 401,
      "old password is rejected",
    );
    check(
      (await https.request(published.targetPath, { headers: { cookie: firstGrantCookie } }))
        .status === 302,
      "old password grant is revoked immediately",
    );
    const nextGrant = await login(published.targetPath, nextPassword);
    check(nextGrant.status === 200, "regenerated password grants access");
    const nextGrantCookie = responseCookies(nextGrant);

    await page.getByRole("button", { name: "关闭密码访问" }).click();
    await page.getByRole("button", { name: "确认关闭" }).click();
    await page.getByText("组织访问", { exact: true }).waitFor();
    check(
      (await https.request(published.targetPath, { headers: { cookie: nextGrantCookie } }))
        .status === 302,
      "disable revokes the current password grant",
    );
    const disabledEntry = await https.request(
      `/auth/password?return_path=${encodeURIComponent(published.targetPath)}`,
    );
    check(
      disabledEntry.status === 302 &&
        disabledEntry.headers.location.startsWith("/auth/content-login?"),
      "disabled project no longer offers password verification",
    );

    const afterManagement = await h.prisma.demoProject.findUniqueOrThrow({
      include: { fileObjects: { orderBy: { relativePath: "asc" } } },
      where: { id: before.id },
    });
    check(
      afterManagement.currentRevisionId === before.currentRevisionId &&
        stableJson(afterManagement.fileObjects) === stableJson(before.fileObjects),
      "management lifecycle preserves the revision and exact files",
    );
    check(
      afterManagement.encryptedPassword === null && afterManagement.passwordHash === null,
      "disable clears both project password forms",
    );
    check(
      (await h.prisma.auditLog.count({
        where: {
          projectId: before.id,
          action: {
            in: ["PASSWORD_ACCESS_ENABLE", "PASSWORD_ACCESS_REGENERATE", "PASSWORD_ACCESS_DISABLE"],
          },
        },
      })) === 3,
      "all three management changes write password-free audit events",
    );

    await page.goto(`${webUrl}/demos`);
    const projectRow = page.locator("tr").filter({ hasText: published.result.project_id });
    await projectRow.getByRole("button", { name: "删除" }).click();
    await page.getByLabel(/输入项目标识/).fill(published.result.project_id);
    await page.getByRole("button", { name: "永久删除" }).click();
    await projectRow.waitFor({ state: "detached" });
    const deleted = await h.prisma.demoProject.findUniqueOrThrow({ where: { id: before.id } });
    check(
      deleted.status === "DELETED" &&
        deleted.encryptedPassword === null &&
        deleted.passwordHash === null,
      "real Web deletion clears managed password material",
    );
    check((await https.request(published.targetPath)).status === 404, "deleted exact path is 404");
    check(
      await page.evaluate(async () => {
        const databases = await globalThis.indexedDB.databases();
        return (
          databases.length === 0 &&
          globalThis.localStorage.length === 0 &&
          globalThis.sessionStorage.length === 0
        );
      }),
      "management Web persists no password in browser storage",
    );
  } finally {
    await context.close();
    await browser.close();
  }
}

async function login(targetPath, password) {
  const page = await https.request(`/auth/password?return_path=${encodeURIComponent(targetPath)}`);
  return https.request("/auth/password/verify", {
    body: JSON.stringify({ password, state: responseState(page) }),
    headers: {
      "content-type": "application/json",
      cookie: responseCookies(page),
      origin: demoUrl,
    },
    method: "POST",
  });
}

function stableJson(value) {
  return JSON.stringify(value, (_key, nested) =>
    typeof nested === "bigint" ? nested.toString() : nested,
  );
}
