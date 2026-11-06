import { randomUUID } from "node:crypto";
import { createSquareService } from "../packages/core/dist/index.js";
export function square(f, repository = f.repositories.square) {
  let unavailable = false;
  let member = { userId: "EnterpriseCase", departmentIds: ["11", "10", "1"] };
  const directory = {
    async getSnapshot() {
      if (unavailable) throw new Error("unavailable");
      return {
        limited: false,
        departments: [
          { id: "10", name: "研发", parentId: "1", path: "组织/研发", hasChildren: true },
        ],
        users: [{ id: "EnterpriseCase", name: "同名人员", departmentPaths: ["组织/研发/后端"] }],
      };
    },
    async resolveMember() {
      if (unavailable) throw new Error("unavailable");
      return member;
    },
  };
  const service = createSquareService({
    repository,
    directory,
    demoWebUrl: "https://demo.example.com",
    now: () => f.now,
  });
  return {
    service,
    setUnavailable(value) {
      unavailable = value;
    },
    setMember(value) {
      member = value;
    },
  };
}
export function owner(f, projectKey) {
  return { tenantId: f.tenant.id, ownerUserId: f.owner.id, projectKey };
}
export function save(f, service, projectKey, change, override = {}) {
  return service.saveSettings({
    ...owner(f, projectKey),
    requestIp: "127.0.0.1",
    traceId: randomUUID(),
    change,
    ...override,
  });
}
export const organization = (settingsVersion = 0) => ({
  enabled: true,
  settingsVersion,
  audienceType: "organization",
});
export const selected = (settingsVersion = 0) => ({
  enabled: true,
  settingsVersion,
  audienceType: "selected",
  departmentIds: ["10"],
  userIds: ["EnterpriseCase"],
});

export async function publishedTime(f, projectKey) {
  return (
    await f.db.demoProject.findUniqueOrThrow({
      where: { projectKey },
      select: { currentRevision: { select: { publishedAt: true } } },
    })
  ).currentRevision.publishedAt;
}
