import type { Page } from "@playwright/test";

export const webUrl = process.env.HTML_SHARE_DETAIL_WEB_URL ?? "http://localhost:3000";
export const project = {
  accessMode: "organization" as const,
  passwordStatus: "disabled" as const,
  createdAt: "2026-09-07T00:00:00Z",
  updatedAt: "2026-09-07T01:00:00Z",
  displayName: "产品演示",
  projectId: "abc12",
  fileCount: 3,
  totalSize: 1024,
  projectPrefix: "http://demo.localhost:3001/abc12/",
};
export const files = [
  "assets/app.js",
  "中文目录/页面 #?%&.html",
  `${"nested/".repeat(12)}long-page.html`,
].map((relativePath) => ({
  relativePath,
  size: 128,
  url: `http://demo.localhost:3001/abc12/${relativePath.split("/").map(encodeURIComponent).join("/")}`,
}));

export async function mockDemoDetail(page: Page) {
  // All management requests are intercepted; these tests never write to a database.
  await page.route("**/auth/current", (route) =>
    route.fulfill({ json: { user: { displayName: "测试用户" }, csrfToken: "test-only" } }),
  );
  await page.route("**/api/projects", (route) =>
    route.fulfill({
      json: {
        projects: [project],
        csrfToken: "test-only",
        quota: {
          projectCount: 1,
          projectLimit: 100,
          storageBytes: 1024,
          storageLimitBytes: 2147483648,
        },
      },
    }),
  );
  await page.route("**/api/projects/abc12", (route) =>
    route.fulfill({ json: { csrfToken: "test-only", project, files } }),
  );
  await page.route("**/api/projects/abc12/square", (route) =>
    route.fulfill({
      json: {
        csrfToken: "test-only",
        settings: {
          enabled: false,
          audienceType: null,
          departmentIds: [],
          userIds: [],
          settingsVersion: 0,
          selectedDepartments: [],
          selectedUsers: [],
        },
      },
    }),
  );
}
