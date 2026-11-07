import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDisabledDirectoryProvider,
  createLiveDirectoryProvider,
} from "./directory-client.js";
import { createSimulatorDirectoryProvider, simulatorIdentity } from "./directory-simulator.js";
import { defaultDirectoryResponse, directoryFixture, success } from "./directory-test-fixture.js";

afterEach(() => vi.useRealTimers());

describe("DingTalk member verification", () => {
  it("maps unionId to an independent enterprise id and checks all current department ancestors", async () => {
    const { options, fetcher } = directoryFixture((path, body) =>
      path === "/auth/scopes" ? { errcode: 60011 } : defaultDirectoryResponse(path, body),
    );
    const member = await createLiveDirectoryProvider(options).resolveMember({
      tenantId: "tenant",
      unionId: "union-2",
    });
    expect(member).toEqual({ userId: "user-2", departmentIds: ["11", "10", "1", "20"] });
    // active:false means not activated; it is not evidence of leaving the organization.
    const paths = fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).not.toContain("/auth/scopes");
    expect(paths).not.toContain("/topapi/user/listsimple");
    expect(paths.filter((path) => path === "/topapi/v2/department/listparentbydept")).toHaveLength(
      2,
    );
  });

  it("rejects external contacts or absent contact type before looking up the user", async () => {
    for (const contactType of [1, undefined, "0"]) {
      const { options, fetcher } = directoryFixture((path, body) =>
        path === "/topapi/user/getbyunionid"
          ? success({ userid: "user-2", contact_type: contactType })
          : defaultDirectoryResponse(path, body),
      );
      await expect(
        createLiveDirectoryProvider(options).resolveMember({
          tenantId: "tenant",
          unionId: "union-2",
        }),
      ).rejects.toMatchObject({ reason: "identity_unconfirmed" });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it("rejects user id or union id mismatches even for the same display name", async () => {
    for (const details of [
      { userid: "different-user", unionid: "union-2" },
      { userid: "user-2", unionid: "different-union" },
      { userid: "user-2", unionid: undefined },
    ]) {
      const { options } = directoryFixture((path, body) =>
        path === "/topapi/v2/user/get"
          ? success({ ...details, name: "同名人员", dept_id_list: [11] })
          : defaultDirectoryResponse(path, body),
      );
      await expect(
        createLiveDirectoryProvider(options).resolveMember({
          tenantId: "tenant",
          unionId: "union-2",
        }),
      ).rejects.toMatchObject({ code: "DIRECTORY_UNAVAILABLE" });
    }
  });

  it("rejects missing, cyclic or incomplete department ancestry", async () => {
    for (const parents of [[], [11, 10], [10, 1], [11, 10, 11, 1]]) {
      const { options } = directoryFixture((path, body) =>
        path === "/topapi/v2/department/listparentbydept"
          ? success({ parent_id_list: parents })
          : defaultDirectoryResponse(path, body),
      );
      await expect(
        createLiveDirectoryProvider(options).resolveMember({
          tenantId: "tenant",
          unionId: "union-2",
        }),
      ).rejects.toMatchObject({ reason: "invalid_response" });
    }
  });

  it("rejects upstream errors without returning response data, credentials or URLs", async () => {
    for (const errcode of [60011, 50002, 50004, 40014, 42001]) {
      const { options } = directoryFixture((path, body) =>
        path === "/topapi/user/getbyunionid"
          ? { errcode, errmsg: "private-person-data" }
          : defaultDirectoryResponse(path, body),
      );
      const error = await createLiveDirectoryProvider(options)
        .resolveMember({ tenantId: "tenant", unionId: "private-union" })
        .catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        reason: "provider_rejected",
        message: "DIRECTORY_UNAVAILABLE",
      });
      expect(JSON.stringify(error)).not.toMatch(/private-|example\.test|access_token|appsecret/);
    }
  });

  it("invalidates an expired application token and permits a fresh-token retry", async () => {
    let expired = true;
    const { options, fetcher } = directoryFixture((path, body) => {
      if (path === "/topapi/user/getbyunionid" && expired) {
        expired = false;
        return { errcode: 42001 };
      }
      return defaultDirectoryResponse(path, body);
    });
    const provider = createLiveDirectoryProvider(options);
    await expect(
      provider.resolveMember({ tenantId: "tenant", unionId: "union-2" }),
    ).rejects.toThrow();
    await expect(
      provider.resolveMember({ tenantId: "tenant", unionId: "union-2" }),
    ).resolves.toMatchObject({ userId: "user-2" });
    expect(
      fetcher.mock.calls.filter(([input]) => String(input).includes("/gettoken")),
    ).toHaveLength(2);
  });
});

describe("directory availability boundaries", () => {
  it("fails a stalled request after ten seconds even if the transport ignores abort", async () => {
    vi.useFakeTimers();
    const { options } = directoryFixture(() => new Promise(() => undefined));
    const operation = createLiveDirectoryProvider(options).getSnapshot({ tenantId: "tenant" });
    const assertion = expect(operation).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
  });

  it("bounds the entire multi-page directory refresh to sixty seconds", async () => {
    vi.useFakeTimers();
    const { options } = directoryFixture(async (path, body) => {
      await new Promise((resolve) => setTimeout(resolve, 7_000));
      return defaultDirectoryResponse(path, body);
    });
    const operation = createLiveDirectoryProvider(options).getSnapshot({ tenantId: "tenant" });
    const assertion = expect(operation).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(60_001);
    await assertion;
  });

  it("rejects HTTP errors, malformed JSON and unconfirmed success status", async () => {
    for (const payload of [
      new Response("private-data", { status: 500 }),
      new Response("not-json"),
      { access_token: "token", expires_in: 7200 },
      { errcode: "0", access_token: "token", expires_in: 7200 },
    ]) {
      const { options } = directoryFixture(() => payload);
      await expect(
        createLiveDirectoryProvider(options).getSnapshot({ tenantId: "tenant" }),
      ).rejects.toMatchObject({ message: "DIRECTORY_UNAVAILABLE" });
    }
  });

  it("keeps the disabled provider explicitly unavailable", async () => {
    const disabled = createDisabledDirectoryProvider();
    await expect(disabled.getSnapshot({ tenantId: "tenant" })).rejects.toMatchObject({
      reason: "disabled",
    });
    await expect(
      disabled.resolveMember({ tenantId: "tenant", unionId: "union" }),
    ).rejects.toMatchObject({ reason: "disabled" });
  });
});

describe("synthetic directory fixtures", () => {
  it("includes unregistered users, duplicate names, nested and multiple departments", async () => {
    const provider = createSimulatorDirectoryProvider();
    const snapshot = await provider.getSnapshot({ tenantId: "tenant" });
    expect(snapshot.users.find((user) => user.id === "simulator-enterprise-user-004")?.name).toBe(
      "模拟未登录成员",
    );
    expect(snapshot.users.filter((user) => user.name === "模拟非创建者")).toHaveLength(2);
    expect(snapshot.departments.filter((department) => department.name === "设计组")).toHaveLength(
      2,
    );
    expect(
      await provider.resolveMember({ tenantId: "tenant", unionId: "simulator-union-002" }),
    ).toEqual({ userId: "simulator-enterprise-user-002", departmentIds: ["11", "10", "1", "20"] });
    expect(
      (await provider.resolveMember({ tenantId: "tenant", unionId: "simulator-union-003" }))
        .departmentIds,
    ).not.toContain("10");
    expect(simulatorIdentity("simulator-member-004")).toEqual({
      dingtalkUserId: "simulator-user-004",
      dingtalkUnionId: "simulator-union-004",
      displayName: "模拟未登录成员",
    });
    await expect(
      provider.resolveMember({ tenantId: "tenant", unionId: "simulator-user-002" }),
    ).rejects.toThrow();
  });
});
