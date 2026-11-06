import { describe, expect, it, vi } from "vitest";

import {
  DirectoryUnavailableError,
  type DirectoryGateway,
  type DirectoryMember,
} from "./contracts.js";
import { createDirectoryService } from "./directory-service.js";

function provider() {
  return {
    getSnapshot: vi.fn<DirectoryGateway["getSnapshot"]>().mockResolvedValue({
      departments: [{ id: "1", name: "组织", path: "组织", parentId: null, hasChildren: false }],
      users: [],
      limited: false,
    }),
    resolveMember: vi.fn<DirectoryGateway["resolveMember"]>().mockResolvedValue({
      userId: "enterprise-1",
      departmentIds: ["11", "10", "1"],
    }),
  };
}

describe("directory cache authorization bounds", () => {
  it("isolates tenant and union identity cache entries and coalesces concurrent refreshes", async () => {
    const source = provider();
    const service = createDirectoryService(source, { corpId: "corp-1" });
    const input = { tenantId: "tenant-1", unionId: "union-1" };
    await Promise.all([service.resolveMember(input), service.resolveMember(input)]);
    await service.resolveMember(input);
    await service.resolveMember({ ...input, tenantId: "tenant-2" });
    await service.resolveMember({ ...input, unionId: "union-2" });
    expect(source.resolveMember).toHaveBeenCalledTimes(3);
    await Promise.all([service.getSnapshot(input), service.getSnapshot(input)]);
    await service.getSnapshot({ tenantId: "tenant-2" });
    expect(source.getSnapshot).toHaveBeenCalledTimes(2);
    const anotherCorp = createDirectoryService(source, { corpId: "corp-2" });
    await anotherCorp.resolveMember(input);
    expect(source.resolveMember).toHaveBeenCalledTimes(4);
  });

  it("expires at five minutes from fetch start, rejects failed refresh, and retries safely", async () => {
    let now = 1_000;
    const source = provider();
    source.resolveMember.mockImplementationOnce(async () => {
      now = 61_000;
      return { userId: "old-user", departmentIds: ["10", "1"] };
    });
    const service = createDirectoryService(source, { now: () => now, ttlMs: 900_000 });
    const input = { tenantId: "tenant-1", unionId: "union-1" };
    await service.resolveMember(input);
    now = 300_999;
    expect((await service.resolveMember(input)).userId).toBe("old-user");
    now = 301_000;
    source.resolveMember.mockRejectedValueOnce(new Error("private provider payload"));
    await expect(service.resolveMember(input)).rejects.toMatchObject({
      code: "DIRECTORY_UNAVAILABLE",
      message: "DIRECTORY_UNAVAILABLE",
    });
    expect((await service.resolveMember(input)).userId).toBe("enterprise-1");
    expect(source.resolveMember).toHaveBeenCalledTimes(3);
  });

  it("never serves a snapshot after expiry when the refresh fails", async () => {
    let now = 0;
    const source = provider();
    const service = createDirectoryService(source, { now: () => now });
    await service.getSnapshot({ tenantId: "tenant-1" });
    now = 300_000;
    source.getSnapshot.mockRejectedValue(new DirectoryUnavailableError("provider_rejected"));
    await expect(service.getSnapshot({ tenantId: "tenant-1" })).rejects.toMatchObject({
      reason: "provider_rejected",
    });
    await expect(service.getSnapshot({ tenantId: "tenant-1" })).rejects.toBeInstanceOf(
      DirectoryUnavailableError,
    );
    expect(source.getSnapshot).toHaveBeenCalledTimes(3);
  });

  it("does not authorize with a response which finishes after its TTL", async () => {
    let now = 0;
    let release: ((member: DirectoryMember) => void) | undefined;
    const source = provider();
    source.resolveMember.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const service = createDirectoryService(source, { now: () => now, ttlMs: 100 });
    const result = service.resolveMember({ tenantId: "tenant-1", unionId: "union-1" });
    now = 100;
    release?.({ userId: "late-member", departmentIds: ["1"] });
    await expect(result).rejects.toMatchObject({ reason: "timeout" });
    expect((await service.resolveMember({ tenantId: "tenant-1", unionId: "union-1" })).userId).toBe(
      "enterprise-1",
    );
  });

  it("keeps member authorization independent of the full directory and prevents cache mutation", async () => {
    const source = provider();
    source.getSnapshot.mockRejectedValue(new DirectoryUnavailableError("provider_rejected"));
    const service = createDirectoryService(source);
    const input = { tenantId: "tenant-1", unionId: "union-1" };
    const member = await service.resolveMember(input);
    member.departmentIds.push("attacker-department");
    expect((await service.resolveMember(input)).departmentIds).toEqual(["11", "10", "1"]);
    expect(source.getSnapshot).not.toHaveBeenCalled();
    await expect(service.getSnapshot(input)).rejects.toBeInstanceOf(DirectoryUnavailableError);
    expect((await service.resolveMember(input)).userId).toBe("enterprise-1");
  });

  it("rejects missing identity and invalid TTL instead of widening authorization", () => {
    const source = provider();
    const service = createDirectoryService(source);
    expect(() => service.resolveMember({ tenantId: "tenant-1", unionId: " " })).toThrow(
      DirectoryUnavailableError,
    );
    expect(() => service.getSnapshot({ tenantId: "" })).toThrow(DirectoryUnavailableError);
    for (const ttlMs of [0, -1, NaN, Infinity]) {
      expect(() => createDirectoryService(source, { ttlMs })).toThrow();
    }
    expect(source.resolveMember).not.toHaveBeenCalled();
  });
});
