import { vi } from "vitest";

import type { LiveDirectoryProviderOptions } from "./directory-client.js";

export type DirectoryHandler = (
  path: string,
  body: Record<string, unknown>,
) => unknown | Promise<unknown>;

export function directoryFixture(override?: DirectoryHandler) {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const payload = await (override
      ? override(url.pathname, body)
      : defaultDirectoryResponse(url.pathname, body));
    return payload instanceof Response ? payload : new Response(JSON.stringify(payload));
  });
  const options: LiveDirectoryProviderOptions = {
    corpId: "test-corp",
    clientId: "test-client",
    clientSecret: "private-test-secret",
    contactApiBaseUrl: "https://contact.example.test",
    fetcher,
  };
  return { fetcher, options };
}

export function defaultDirectoryResponse(path: string, body: Record<string, unknown>): unknown {
  if (path === "/gettoken")
    return { errcode: 0, access_token: "private-test-token", expires_in: 7200 };
  if (path === "/auth/scopes") {
    return { errcode: 0, auth_org_scopes: { authed_dept: [10], authed_user: ["user-4"] } };
  }
  if (path === "/topapi/v2/department/get") {
    return success({ dept_id: body["dept_id"], parent_id: 1, name: "产品部" });
  }
  if (path === "/topapi/v2/department/listsub") {
    return success(body["dept_id"] === 10 ? [{ dept_id: 11, parent_id: 10, name: "设计组" }] : []);
  }
  if (path === "/topapi/user/listsimple") {
    if (body["dept_id"] === 10 && body["cursor"] === 0) {
      return success({
        list: [{ userid: "user-1", name: "同名人员" }],
        has_more: true,
        next_cursor: 7,
      });
    }
    return success({ list: [{ userid: "user-2", name: "同名人员" }], has_more: false });
  }
  if (path === "/topapi/user/getbyunionid") return success({ userid: "user-2", contact_type: 0 });
  if (path === "/topapi/v2/user/get") {
    return success({
      userid: body["userid"],
      name: "同名人员",
      unionid: "union-2",
      active: false,
      dept_id_list: body["userid"] === "user-4" ? [99] : [11, 20],
    });
  }
  if (path === "/topapi/v2/department/listparentbydept") {
    return success({ parent_id_list: body["dept_id"] === 11 ? [11, 10, 1] : [20, 1] });
  }
  throw new Error("Unexpected directory fixture endpoint");
}

export function success(result: unknown) {
  return { errcode: 0, result };
}
