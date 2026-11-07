export interface SquareDepartment {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  hasChildren: boolean;
}

export interface SquareUser {
  id: string;
  name: string;
  departmentPaths: string[];
}
export interface SquareMember {
  userId: string;
  departmentIds: string[];
}
export interface SquareDirectoryGateway {
  getSnapshot(input: { tenantId: string }): Promise<{
    departments: SquareDepartment[];
    users: SquareUser[];
    limited: boolean;
  }>;
  resolveMember(input: { tenantId: string; unionId: string }): Promise<SquareMember | null>;
}
export interface SquareSettings {
  enabled: boolean;
  audienceType: "organization" | "selected" | null;
  departmentIds: string[];
  userIds: string[];
  settingsVersion: number;
  selectedDepartments: SquareDepartment[];
  selectedUsers: SquareUser[];
}
export interface SquareOwner {
  tenantId: string;
  ownerUserId: string;
  projectKey: string;
}
export interface SquareViewer {
  tenantId: string;
  userId: string;
  unionId?: string | null;
}
export interface SquareVisibility {
  tenantId: string;
  userId: string;
  member: SquareMember | null;
}
export interface SquareChange {
  enabled: boolean;
  settingsVersion: number;
  audienceType?: "organization" | "selected";
  departmentIds?: string[];
  userIds?: string[];
}
export type SquareStoredCover =
  | { status: "pending" | "failed" }
  | { status: "ready"; targetHash: string; privateImageKey: string };

export interface SquareStoredProject {
  projectKey: string;
  displayName: string;
  creatorDisplayName: string;
  updatedAt: Date;
  fileCount: number;
  totalSize: number;
  homepagePath: string | null;
  cover?: SquareStoredCover;
  files: { relativePath: string; size: number }[];
}
export interface SquareWriteContext extends SquareOwner {
  requestIp: string;
  traceId: string;
  now: Date;
}
export interface SquareRepository {
  findOwnedSettings(input: SquareOwner): Promise<SquareSettings | null>;
  saveOwnedSettings(
    input: SquareWriteContext & {
      expectedVersion: number;
      settings: SquareSettings;
    },
  ): Promise<SquareSettings>;
  recordFailure(
    input: SquareWriteContext & {
      action: "publish" | "update" | "disable";
      result: string;
      settingsVersion: number;
    },
  ): Promise<void>;
  listVisible(
    input: SquareVisibility & {
      q: string;
      creator?: string;
      page: number;
      pageSize: number;
    },
  ): Promise<{ projects: SquareStoredProject[]; total: number; page: number; pageSize: number }>;
  findVisible(
    input: SquareVisibility & { projectKey: string },
  ): Promise<SquareStoredProject | null>;
}
export class SquareError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(squareMessages[code] ?? "广场操作失败，请重试");
    this.name = "SquareError";
  }
}
export function emptySquareSettings(): SquareSettings {
  return {
    enabled: false,
    audienceType: null,
    departmentIds: [],
    userIds: [],
    settingsVersion: 0,
    selectedDepartments: [],
    selectedUsers: [],
  };
}

const squareMessages: Record<string, string> = {
  SQUARE_NOT_FOUND: "项目不存在或不可访问",
  SQUARE_INVALID_SETTINGS: "请选择有效范围并重新提交",
  SQUARE_INVALID_AUDIENCE: "所选部门或人员已失效或不在授权范围，请重新选择",
  SQUARE_INVALID_QUERY: "搜索条件或分页参数无效",
  SQUARE_VERSION_CONFLICT: "共享设置已更新，请重新加载后保存",
  SQUARE_UPLOAD_CONFLICT: "项目正在上传，请完成后重试",
  SQUARE_DIRECTORY_UNAVAILABLE: "组织目录暂不可用，请重试或联系管理员开通权限",
};
