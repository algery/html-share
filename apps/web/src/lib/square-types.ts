export interface DirectoryDepartment {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  hasChildren: boolean;
}

export interface DirectoryUser {
  id: string;
  name: string;
  departmentPaths: string[];
}

export type DirectoryItem =
  (DirectoryDepartment & { kind: "department" }) | (DirectoryUser & { kind: "user" });

export interface DirectoryPage<T> {
  items: T[];
  nextCursor: string | null;
  limited: boolean;
}

export interface SquareSettings {
  enabled: boolean;
  audienceType: "organization" | "selected" | null;
  departmentIds: string[];
  userIds: string[];
  settingsVersion: number;
  selectedDepartments: DirectoryDepartment[];
  selectedUsers: DirectoryUser[];
}

export interface SquareSettingsResponse {
  csrfToken: string | null;
  settings: SquareSettings;
}

export interface SquareDraft {
  audienceType: SquareSettings["audienceType"];
  departments: DirectoryDepartment[];
  users: DirectoryUser[];
}

export interface SquareProject {
  projectId: string;
  displayName: string;
  creatorDisplayName: string;
  updatedAt: string;
  fileCount: number;
  totalSize: number;
  homepage?: {
    configuredPath: string | null;
    path: string | null;
    source: "manual" | "automatic" | "missing" | "ambiguous" | "none";
    url: string | null;
  };
}

export interface SquareListResponse {
  projects: SquareProject[];
  total: number;
  page: number;
  pageSize: number;
  directoryUnavailable?: boolean;
}

export interface SquareDetailResponse {
  project: SquareProject;
  files: { relativePath: string; size: number; url: string }[];
}

export const SQUARE_SCOPE_NOTICE =
  "可见范围仅影响项目广场；同组织成员持链接仍可访问，已开启密码访问的项目也可凭密码访问。";

export function squareDraft(settings: SquareSettings): SquareDraft {
  return {
    audienceType: settings.audienceType,
    departments: settings.departmentIds.map(
      (id) =>
        settings.selectedDepartments.find((item) => item.id === id) ?? {
          id,
          name: "部门信息暂不可用",
          parentId: null,
          path: "请重新加载核对",
          hasChildren: false,
        },
    ),
    users: settings.userIds.map(
      (id) =>
        settings.selectedUsers.find((item) => item.id === id) ?? {
          id,
          name: "人员信息暂不可用",
          departmentPaths: ["请重新加载核对"],
        },
    ),
  };
}

export function audienceSummary(draft: SquareDraft) {
  if (draft.audienceType === "organization") return "全组织成员";
  if (draft.audienceType === null) return "尚未选择范围";
  return `${draft.departments.length} 个部门（含子部门）、${draft.users.length} 位人员`;
}
