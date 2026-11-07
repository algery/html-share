import { describe, expect, it } from "vitest";

import { createLiveDirectoryProvider } from "./directory-client.js";
import { defaultDirectoryResponse, directoryFixture, success } from "./directory-test-fixture.js";

describe("DingTalk authorized directory snapshot", () => {
  it("walks authorized roots, follows pagination, merges departments and keeps names distinct", async () => {
    const { options, fetcher } = directoryFixture();
    const result = await createLiveDirectoryProvider(options).getSnapshot({ tenantId: "tenant" });
    expect(result.limited).toBe(true);
    expect(result.departments).toEqual([
      { id: "10", name: "产品部", parentId: null, path: "产品部", hasChildren: true },
      { id: "11", name: "设计组", parentId: "10", path: "产品部 / 设计组", hasChildren: false },
    ]);
    expect(result.users).toEqual([
      { id: "user-1", name: "同名人员", departmentPaths: ["产品部"] },
      { id: "user-2", name: "同名人员", departmentPaths: ["产品部", "产品部 / 设计组"] },
      { id: "user-4", name: "同名人员", departmentPaths: ["未授权部门（99）"] },
    ]);
    const paths = fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths.filter((path) => path === "/gettoken")).toHaveLength(1);
    const pages = fetcher.mock.calls.filter(([input]) => String(input).includes("/listsimple"));
    expect(pages.map(([, init]) => JSON.parse(String(init?.body)).cursor)).toEqual([0, 7, 0]);
    expect(pages[0]?.[1]?.body).toContain('"contain_access_limit":false');
    expect(
      fetcher.mock.calls.find(([input]) => String(input).includes("/department/get"))?.[1]?.body,
    ).toContain('"dept_id":10');
  });

  it("marks a root-authorized snapshot complete without treating an inaccessible root as empty", async () => {
    const { options } = directoryFixture((path, body) => {
      if (path === "/auth/scopes") {
        return { errcode: 0, auth_org_scopes: { authed_dept: [1], authed_user: [] } };
      }
      if (path === "/topapi/v2/department/get")
        return success({ dept_id: 1, parent_id: 0, name: "组织" });
      if (path === "/topapi/v2/department/listsub") return success([]);
      return defaultDirectoryResponse(path, body);
    });
    const result = await createLiveDirectoryProvider(options).getSnapshot({ tenantId: "tenant" });
    expect(result.limited).toBe(false);
    expect(result.departments[0]?.id).toBe("1");
  });

  it("loads directly authorized users even with no authorized department roots", async () => {
    const { options, fetcher } = directoryFixture((path, body) =>
      path === "/auth/scopes"
        ? { errcode: 0, auth_org_scopes: { authed_dept: [], authed_user: ["user-4", "user-4"] } }
        : defaultDirectoryResponse(path, body),
    );
    const result = await createLiveDirectoryProvider(options).getSnapshot({ tenantId: "tenant" });
    expect(result).toMatchObject({ limited: true, departments: [], users: [{ id: "user-4" }] });
    expect(
      fetcher.mock.calls.filter(([input]) => String(input).includes("/v2/user/get")),
    ).toHaveLength(1);
  });

  it("rejects a later page failure instead of caching a partially loaded directory", async () => {
    const { options } = directoryFixture((path, body) =>
      path === "/topapi/user/listsimple" && body["cursor"] === 7
        ? { errcode: 50002, errmsg: "private user info" }
        : defaultDirectoryResponse(path, body),
    );
    await expect(
      createLiveDirectoryProvider(options).getSnapshot({ tenantId: "tenant" }),
    ).rejects.toMatchObject({ code: "DIRECTORY_UNAVAILABLE", reason: "provider_rejected" });
  });

  it("rejects pagination loops and malformed pagination flags", async () => {
    for (const page of [
      { list: [{ userid: "user-1", name: "成员" }], has_more: true, next_cursor: 0 },
      { list: [], has_more: true, next_cursor: 7 },
      { list: [], has_more: "false" },
    ]) {
      const { options } = directoryFixture((path, body) =>
        path === "/topapi/user/listsimple" ? success(page) : defaultDirectoryResponse(path, body),
      );
      await expect(
        createLiveDirectoryProvider(options).getSnapshot({ tenantId: "tenant" }),
      ).rejects.toMatchObject({ reason: "invalid_response" });
    }
  });

  it("rejects inconsistent department identifiers and recursive hierarchy cycles", async () => {
    const mismatch = directoryFixture((path, body) =>
      path === "/topapi/v2/department/get"
        ? success({ dept_id: 999, name: "错误部门", parent_id: 1 })
        : defaultDirectoryResponse(path, body),
    );
    await expect(
      createLiveDirectoryProvider(mismatch.options).getSnapshot({ tenantId: "tenant" }),
    ).rejects.toMatchObject({ reason: "invalid_response" });
    const cycle = directoryFixture((path, body) => {
      if (path === "/topapi/v2/department/get")
        return success({ dept_id: 10, parent_id: 11, name: "产品部" });
      if (path === "/topapi/v2/department/listsub" && body["dept_id"] === 11) {
        return success([{ dept_id: 10, parent_id: 11, name: "产品部" }]);
      }
      return defaultDirectoryResponse(path, body);
    });
    await expect(
      createLiveDirectoryProvider(cycle.options).getSnapshot({ tenantId: "tenant" }),
    ).rejects.toMatchObject({ reason: "invalid_response" });
  });

  it("fails before enumerating oversized authorization scopes", async () => {
    for (const scope of [
      { authed_dept: Array.from({ length: 10_001 }, (_, i) => i + 1), authed_user: [] },
      { authed_dept: [], authed_user: Array.from({ length: 50_001 }, (_, i) => `user-${i}`) },
    ]) {
      const { options, fetcher } = directoryFixture((path, body) =>
        path === "/auth/scopes"
          ? { errcode: 0, auth_org_scopes: scope }
          : defaultDirectoryResponse(path, body),
      );
      await expect(
        createLiveDirectoryProvider(options).getSnapshot({ tenantId: "tenant" }),
      ).rejects.toMatchObject({ reason: "limit_exceeded" });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it("rejects department expansion beyond the cap instead of truncating it", async () => {
    const { options } = directoryFixture((path, body) =>
      path === "/topapi/v2/department/listsub"
        ? success(
            Array.from({ length: 10_000 }, (_, index) => ({
              dept_id: 100 + index,
              parent_id: 10,
              name: `子部门 ${index}`,
            })),
          )
        : defaultDirectoryResponse(path, body),
    );
    await expect(
      createLiveDirectoryProvider(options).getSnapshot({ tenantId: "tenant" }),
    ).rejects.toMatchObject({ reason: "limit_exceeded" });
  });

  it("rejects accumulated paginated users beyond the cap", async () => {
    const { options } = directoryFixture((path, body) => {
      if (path === "/topapi/v2/department/listsub") return success([]);
      if (path === "/topapi/user/listsimple") {
        const cursor = Number(body["cursor"]);
        return success({
          list: Array.from({ length: 100 }, (_, index) => ({
            userid: `user-${cursor * 100 + index}`,
            name: "成员",
          })),
          has_more: cursor < 500,
          next_cursor: cursor + 1,
        });
      }
      return defaultDirectoryResponse(path, body);
    });
    await expect(
      createLiveDirectoryProvider(options).getSnapshot({ tenantId: "tenant" }),
    ).rejects.toMatchObject({ reason: "limit_exceeded" });
  });

  it("rejects a mismatching directly authorized user", async () => {
    const { options } = directoryFixture((path, body) =>
      path === "/topapi/v2/user/get"
        ? success({ userid: "attacker", name: "同名人员", dept_id_list: [99] })
        : defaultDirectoryResponse(path, body),
    );
    await expect(
      createLiveDirectoryProvider(options).getSnapshot({ tenantId: "tenant" }),
    ).rejects.toMatchObject({ reason: "invalid_response" });
  });
});
