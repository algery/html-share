import type { Page } from "@playwright/test";
import type {
  DirectoryDepartment,
  DirectoryUser,
  SquareProject,
  SquareSettings,
} from "../../apps/web/src/lib/square-types";

export const squareWebUrl = process.env.HTML_SHARE_SQUARE_WEB_URL ?? "http://localhost:3000";
export const department: DirectoryDepartment = {
  id: "dept-1",
  name: "产品部",
  parentId: null,
  path: "公司 / 产品部",
  hasChildren: true,
};
export const childDepartment: DirectoryDepartment = {
  id: "dept-2",
  name: "产品部",
  parentId: "dept-1",
  path: "公司 / 产品部 / 产品部",
  hasChildren: false,
};
export const user: DirectoryUser = {
  id: "user-new",
  name: "张同学",
  departmentPaths: ["公司 / 研发部"],
};
export const squareFiles = [
  "index.html",
  "中文目录/页面 #?%&.html",
  `${"nested/".repeat(12)}long-page.html`,
].map((relativePath) => ({
  relativePath,
  size: 128,
  url: `http://demo.localhost:3001/abc12/${relativePath.split("/").map(encodeURIComponent).join("/")}`,
}));
export const squareProject: SquareProject = {
  projectId: "abc12",
  displayName: "组织产品演示",
  creatorDisplayName: "创建者张同学",
  updatedAt: "2026-09-07T01:00:00Z",
  fileCount: 3,
  totalSize: 1024,
  homepage: {
    source: "automatic",
    configuredPath: null,
    path: "index.html",
    url: "http://demo.localhost:3001/abc12/index.html",
  },
};

export async function mockSquare(page: Page, enabled = false) {
  const state = {
    settings: {
      enabled,
      audienceType: enabled ? "selected" : null,
      departmentIds: enabled ? [department.id] : [],
      userIds: [],
      settingsVersion: 1,
      selectedDepartments: enabled ? [department] : [],
      selectedUsers: [],
    } as SquareSettings,
    putBodies: [] as Record<string, unknown>[],
    putStatus: 200,
    directoryStatus: 200,
    directoryPagination: false,
    listStatus: 200,
    detailStatus: 200,
    ownerRequests: [] as string[],
    listQueries: [] as string[],
    projects: Array.from({ length: 24 }, (_, index) => ({
      ...squareProject,
      projectId: `abc${index}`,
      displayName: index === 0 ? "很长的中文项目名称".repeat(8) : `组织产品演示 ${index + 1}`,
      homepage:
        index === 1
          ? { source: "missing" as const, configuredPath: "old.html", path: null, url: null }
          : squareProject.homepage,
    })),
  };
  // Every management request is intercepted; no real project or database is written.
  await page.route("**/auth/current", (route) =>
    route.fulfill({ json: { user: { displayName: "测试用户" }, csrfToken: "test-only" } }),
  );
  await page.route("**/api/projects**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    state.ownerRequests.push(path);
    if (path.endsWith("/square")) {
      if (request.method() === "PUT") {
        const body = request.postDataJSON() as Record<string, unknown>;
        state.putBodies.push(body);
        if (state.putStatus !== 200)
          return route.fulfill({ status: state.putStatus, json: { error: "square_write_failed" } });
        const enabled = body["enabled"] === true;
        const ids = (body["departmentIds"] ?? []) as string[];
        const users = (body["userIds"] ?? []) as string[];
        state.settings = {
          ...state.settings,
          enabled,
          settingsVersion: state.settings.settingsVersion + 1,
          ...(enabled
            ? {
                audienceType: body["audienceType"] as "organization" | "selected",
                departmentIds: ids,
                userIds: users,
                selectedDepartments: [department, childDepartment].filter((value) =>
                  ids.includes(value.id),
                ),
                selectedUsers: users.includes(user.id) ? [user] : [],
              }
            : {}),
        };
      }
      return route.fulfill({ json: { csrfToken: "test-only", settings: state.settings } });
    }
    const ownerProject = {
      ...squareProject,
      accessMode: "organization",
      passwordStatus: "disabled",
      createdAt: squareProject.updatedAt,
      projectPrefix: "http://demo.localhost:3001/abc12/",
      squareEnabled: state.settings.enabled,
    };
    return route.fulfill({
      json:
        path === "/api/projects"
          ? {
              csrfToken: "test-only",
              projects: [ownerProject],
              quota: {
                projectCount: 1,
                projectLimit: 100,
                storageBytes: 1024,
                storageLimitBytes: 2147483648,
              },
            }
          : { csrfToken: "test-only", project: ownerProject, files: squareFiles },
    });
  });
  await page.route("**/api/directory/**", (route) => {
    if (state.directoryStatus !== 200)
      return route.fulfill({
        status: state.directoryStatus,
        json: { error: "directory_unavailable" },
      });
    const url = new URL(route.request().url());
    const items =
      url.searchParams.get("q") === "missing"
        ? []
        : url.pathname.endsWith("search")
          ? [
              { ...department, kind: "department" },
              { ...user, kind: "user" },
            ]
          : url.searchParams.has("cursor")
            ? [department, childDepartment]
            : url.searchParams.has("parentId")
              ? [childDepartment]
              : [department];
    return route.fulfill({
      json: {
        items,
        nextCursor:
          state.directoryPagination &&
          !url.searchParams.has("cursor") &&
          !url.searchParams.has("q") &&
          !url.searchParams.has("parentId")
            ? "more"
            : null,
        limited: true,
      },
    });
  });
  await page.route("**/api/square/projects**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/square/projects")
      return route.fulfill({
        status: state.detailStatus,
        json:
          state.detailStatus === 200
            ? { project: squareProject, files: squareFiles }
            : { error: "project_not_found" },
      });
    state.listQueries.push(url.search);
    if (state.listStatus !== 200)
      return route.fulfill({ status: state.listStatus, json: { error: "unavailable" } });
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const filtered = state.projects.filter((project) =>
      project.displayName.toLowerCase().includes(q),
    );
    const pageSize = Number(url.searchParams.get("pageSize") ?? 10);
    const requestedPage = Number(url.searchParams.get("page") ?? 1);
    const page = Math.max(1, Math.min(requestedPage, Math.ceil(filtered.length / pageSize)));
    return route.fulfill({
      json: {
        projects: filtered.slice((page - 1) * pageSize, page * pageSize),
        total: filtered.length,
        page,
        pageSize,
      },
    });
  });
  return state;
}
