import { describe, expect, it } from "vitest";

import {
  createProjectDeletionService,
  ProjectDeletionError,
  type ProjectDeletionRepository,
} from "./delete-service.js";

describe("project deletion service", () => {
  it("delegates an owner deletion and keeps repeated deletion idempotent", async () => {
    const repository = new FakeRepository("deleted");
    const service = createProjectDeletionService({ repository, administratorDingTalkUserIds: [] });

    await expect(
      service.deleteOwnedProject({ projectKey: "abc12", userId: "owner-1" }),
    ).resolves.toBe("deleted");
    repository.ownerOutcome = "already_deleted";
    await expect(
      service.deleteOwnedProject({ projectKey: "abc12", userId: "owner-1" }),
    ).resolves.toBe("already_deleted");
    expect(repository.ownerInput?.ownerUserId).toBe("owner-1");
  });

  it("allows only configured administrators and records a validated reason", async () => {
    const repository = new FakeRepository("deleted");
    const service = createProjectDeletionService({
      administratorDingTalkUserIds: ["admin-dingtalk-id"],
      now: () => new Date("2026-09-03T00:00:00.000Z"),
      repository,
    });
    const actor = { dingtalkUserId: "admin-dingtalk-id", displayName: "Admin", id: "admin-1" };

    await expect(
      service.deleteProjectAsAdministrator({
        actor,
        projectKey: "abc12",
        reason: "  已确认误传了客户信息，需要立即止损。  ",
        requestIp: "127.0.0.1",
        traceId: "trace-1",
      }),
    ).resolves.toBe("deleted");
    expect(repository.adminInput).toMatchObject({
      actorUserId: "admin-1",
      reason: "已确认误传了客户信息，需要立即止损。",
      traceId: "trace-1",
    });
  });

  it("rejects ordinary members and reasons outside 10–500 characters", async () => {
    const service = createProjectDeletionService({
      administratorDingTalkUserIds: ["admin-dingtalk-id"],
      repository: new FakeRepository("deleted"),
    });
    const member = { dingtalkUserId: "member", displayName: "Member", id: "member-1" };
    const admin = { dingtalkUserId: "admin-dingtalk-id", displayName: "Admin", id: "admin-1" };

    await expect(
      service.findProjectAsAdministrator({ actor: member, projectKey: "abc12" }),
    ).rejects.toMatchObject({ code: "ADMIN_FORBIDDEN" });
    await expect(
      service.deleteProjectAsAdministrator({
        actor: admin,
        projectKey: "abc12",
        reason: "太短",
        requestIp: "127.0.0.1",
        traceId: "trace-1",
      }),
    ).rejects.toBeInstanceOf(ProjectDeletionError);
  });
});

class FakeRepository implements ProjectDeletionRepository {
  adminInput: Parameters<ProjectDeletionRepository["deleteAsAdministrator"]>[0] | undefined;
  ownerInput: Parameters<ProjectDeletionRepository["deleteAsOwner"]>[0] | undefined;

  constructor(public ownerOutcome: "already_deleted" | "deleted" | "forbidden" | "not_found") {}

  async deleteAsAdministrator(
    input: Parameters<ProjectDeletionRepository["deleteAsAdministrator"]>[0],
  ) {
    this.adminInput = input;
    return this.ownerOutcome;
  }

  async deleteAsOwner(input: Parameters<ProjectDeletionRepository["deleteAsOwner"]>[0]) {
    this.ownerInput = input;
    return this.ownerOutcome;
  }

  async findForAdministrator() {
    return null;
  }

  async recordAdministratorRateLimit() {
    return undefined;
  }
}
