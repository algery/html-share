import {
  DirectoryUnavailableError,
  type DirectoryGateway,
  type DirectorySnapshot,
  type DingTalkIdentity,
} from "@html-share/core";

const MEMBERS = [
  { suffix: "001", name: "模拟组织成员", departments: ["10"] },
  { suffix: "002", name: "模拟非创建者", departments: ["11", "20"] },
  { suffix: "003", name: "模拟范围外成员", departments: ["20"] },
  { suffix: "004", name: "模拟未登录成员", departments: ["11"] },
  { suffix: "005", name: "模拟非创建者", departments: ["21"] },
];

const DEPARTMENTS = [
  { id: "1", name: "模拟组织", parentId: null, path: "模拟组织", hasChildren: true },
  { id: "10", name: "产品部", parentId: "1", path: "模拟组织 / 产品部", hasChildren: true },
  {
    id: "11",
    name: "设计组",
    parentId: "10",
    path: "模拟组织 / 产品部 / 设计组",
    hasChildren: false,
  },
  { id: "20", name: "研发部", parentId: "1", path: "模拟组织 / 研发部", hasChildren: true },
  {
    id: "21",
    name: "设计组",
    parentId: "20",
    path: "模拟组织 / 研发部 / 设计组",
    hasChildren: false,
  },
];

export function simulatorIdentity(code: string): DingTalkIdentity | undefined {
  const suffix =
    code === "simulator-member" || code === "simulator-external-member"
      ? "001"
      : /^simulator-member-(00[1-5])$/.exec(code)?.[1];
  const member = MEMBERS.find((entry) => entry.suffix === suffix);
  if (!member) return undefined;
  return {
    dingtalkUserId: `simulator-user-${member.suffix}`,
    dingtalkUnionId: `simulator-union-${member.suffix}`,
    displayName: member.name,
  };
}

export function createSimulatorDirectoryProvider(): DirectoryGateway {
  return {
    async getSnapshot({ tenantId }) {
      if (!tenantId.trim()) throw new DirectoryUnavailableError("identity_unconfirmed");
      const snapshot: DirectorySnapshot = {
        limited: false,
        departments: DEPARTMENTS,
        users: MEMBERS.map((member) => ({
          id: `simulator-enterprise-user-${member.suffix}`,
          name: member.name,
          departmentPaths: member.departments.map(
            (id) => DEPARTMENTS.find((department) => department.id === id)?.path ?? id,
          ),
        })),
      };
      return structuredClone(snapshot);
    },
    async resolveMember({ tenantId, unionId }) {
      const member = MEMBERS.find((entry) => `simulator-union-${entry.suffix}` === unionId);
      if (!tenantId.trim() || !member) throw new DirectoryUnavailableError("identity_unconfirmed");
      const ids = new Set<string>();
      for (const current of member.departments) {
        let id: string | null = current;
        while (id) {
          ids.add(id);
          id = DEPARTMENTS.find((department) => department.id === id)?.parentId ?? null;
        }
      }
      return { userId: `simulator-enterprise-user-${member.suffix}`, departmentIds: [...ids] };
    },
  };
}
