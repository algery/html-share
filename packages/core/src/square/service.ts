import { homepageLink } from "../project/homepage.js";
import {
  SquareError,
  type SquareChange,
  type SquareDirectoryGateway,
  type SquareOwner,
  type SquareRepository,
  type SquareSettings,
  type SquareStoredProject,
  type SquareViewer,
  type SquareVisibility,
} from "./contracts.js";

export function createSquareService(options: {
  repository: SquareRepository;
  directory?: SquareDirectoryGateway;
  demoWebUrl: string;
  now?: () => Date;
}) {
  const { repository, directory } = options;
  const now = options.now ?? (() => new Date());
  async function getSettings(input: SquareOwner) {
    const settings = await repository.findOwnedSettings(input);
    if (!settings) throw new SquareError("SQUARE_NOT_FOUND", 404);
    return settings;
  }
  async function visibility(input: SquareViewer) {
    let member: SquareVisibility["member"] = null;
    let directoryUnavailable = false;
    if (!input.unionId || !directory) directoryUnavailable = true;
    else {
      try {
        member = await directory.resolveMember({
          tenantId: input.tenantId,
          unionId: input.unionId,
        });
      } catch {
        directoryUnavailable = true;
      }
      if (!member) directoryUnavailable = true;
    }
    return { tenantId: input.tenantId, userId: input.userId, member, directoryUnavailable };
  }
  function summary(project: SquareStoredProject) {
    return {
      projectId: project.projectKey,
      displayName: project.displayName,
      creatorDisplayName: project.creatorDisplayName,
      updatedAt: project.updatedAt,
      fileCount: project.fileCount,
      totalSize: project.totalSize,
      homepage: homepageLink(
        project.files.map((file) => file.relativePath),
        project.homepagePath,
        project.projectKey,
        options.demoWebUrl,
      ),
    };
  }
  return {
    getSettings,
    async saveSettings(
      input: SquareOwner & {
        change: unknown;
        requestIp: string;
        traceId: string;
      },
    ) {
      const context = {
        tenantId: input.tenantId,
        ownerUserId: input.ownerUserId,
        projectKey: input.projectKey,
        requestIp: input.requestIp,
        traceId: input.traceId,
        now: now(),
      };
      let action: "publish" | "update" | "disable" = "update";
      let settingsVersion = 0;
      try {
        const current = await getSettings(input);
        const change = parseSquareChange(input.change);
        settingsVersion = change.settingsVersion;
        action = change.enabled ? (current.enabled ? "update" : "publish") : "disable";
        const settings = await validatedSettings(change, current, input.tenantId, directory);
        return await repository.saveOwnedSettings({
          ...context,
          expectedVersion: settingsVersion,
          settings,
        });
      } catch (error) {
        await repository.recordFailure({
          ...context,
          action,
          settingsVersion,
          result: error instanceof SquareError ? error.code : "SQUARE_WRITE_FAILED",
        });
        throw error;
      }
    },
    async listProjects(
      input: SquareViewer & { q?: string; creator?: string; page?: number; pageSize?: number },
    ) {
      if (
        (input.q !== undefined && typeof input.q !== "string") ||
        (input.creator !== undefined && typeof input.creator !== "string")
      ) {
        throw new SquareError("SQUARE_INVALID_QUERY", 400);
      }
      const q = (input.q ?? "").trim();
      const creator = (input.creator ?? "").trim();
      const page = input.page ?? 1;
      const pageSize = input.pageSize ?? 10;
      if (
        q.length > 80 ||
        creator.length > 80 ||
        !Number.isSafeInteger(page) ||
        page < 1 ||
        ![10, 20, 50].includes(pageSize)
      ) {
        throw new SquareError("SQUARE_INVALID_QUERY", 400);
      }
      const visible = await visibility(input);
      const result = await repository.listVisible({ ...visible, q, creator, page, pageSize });
      return {
        ...result,
        projects: result.projects.map(summary),
        directoryUnavailable: visible.directoryUnavailable,
      };
    },
    async getProject(input: SquareViewer & { projectKey: string }) {
      const project = await repository.findVisible({
        ...(await visibility(input)),
        projectKey: input.projectKey,
      });
      if (!project) throw new SquareError("SQUARE_NOT_FOUND", 404);
      return {
        project: summary(project),
        files: project.files.map((file) => ({
          relativePath: file.relativePath,
          size: file.size,
          url: new URL(
            `/${project.projectKey}/${file.relativePath.split("/").map(encodeURIComponent).join("/")}`,
            options.demoWebUrl,
          ).toString(),
        })),
      };
    },
  };
}

async function validatedSettings(
  change: SquareChange,
  current: SquareSettings,
  tenantId: string,
  directory: SquareDirectoryGateway | undefined,
): Promise<SquareSettings> {
  if (
    typeof change.enabled !== "boolean" ||
    !Number.isSafeInteger(change.settingsVersion) ||
    change.settingsVersion < 0
  ) {
    throw new SquareError("SQUARE_INVALID_SETTINGS", 400);
  }
  if (change.settingsVersion !== current.settingsVersion)
    throw new SquareError("SQUARE_VERSION_CONFLICT", 409);
  if (!change.enabled) return { ...current, enabled: false };
  const departmentIds = ids(change.departmentIds);
  const userIds = ids(change.userIds);
  if (change.audienceType === "organization") {
    if (departmentIds.length || userIds.length)
      throw new SquareError("SQUARE_INVALID_SETTINGS", 400);
    return {
      ...current,
      enabled: true,
      audienceType: "organization",
      departmentIds,
      userIds,
      selectedDepartments: [],
      selectedUsers: [],
    };
  }
  const count = departmentIds.length + userIds.length;
  if (change.audienceType !== "selected" || count < 1 || count > 100) {
    throw new SquareError("SQUARE_INVALID_SETTINGS", 400);
  }
  if (!directory) throw new SquareError("SQUARE_DIRECTORY_UNAVAILABLE", 503);
  let snapshot: Awaited<ReturnType<SquareDirectoryGateway["getSnapshot"]>>;
  try {
    snapshot = await directory.getSnapshot({ tenantId });
  } catch {
    throw new SquareError("SQUARE_DIRECTORY_UNAVAILABLE", 503);
  }
  const departments = new Map(snapshot.departments.map((item) => [item.id, item]));
  const users = new Map(snapshot.users.map((item) => [item.id, item]));
  if (departmentIds.some((id) => !departments.has(id)) || userIds.some((id) => !users.has(id))) {
    throw new SquareError("SQUARE_INVALID_AUDIENCE", 400);
  }
  return {
    ...current,
    enabled: true,
    audienceType: "selected",
    departmentIds,
    userIds,
    selectedDepartments: departmentIds.map((id) => {
      const item = departments.get(id);
      if (!item) throw new SquareError("SQUARE_INVALID_AUDIENCE", 400);
      return {
        id: item.id,
        name: item.name,
        parentId: item.parentId,
        path: item.path,
        hasChildren: item.hasChildren,
      };
    }),
    selectedUsers: userIds.map((id) => {
      const item = users.get(id);
      if (!item) throw new SquareError("SQUARE_INVALID_AUDIENCE", 400);
      return { id: item.id, name: item.name, departmentPaths: [...item.departmentPaths] };
    }),
  };
}
function ids(value: unknown) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some(
      (id) => typeof id !== "string" || id.length < 1 || id.length > 191 || id.trim() !== id,
    )
  ) {
    throw new SquareError("SQUARE_INVALID_SETTINGS", 400);
  }
  return [...new Set(value)];
}

export function parseSquareChange(value: unknown): SquareChange {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SquareError("SQUARE_INVALID_SETTINGS", 400);
  }
  const body = value as Record<string, unknown>;
  if (
    typeof body["enabled"] !== "boolean" ||
    typeof body["settingsVersion"] !== "number" ||
    !Number.isSafeInteger(body["settingsVersion"]) ||
    body["settingsVersion"] < 0
  ) {
    throw new SquareError("SQUARE_INVALID_SETTINGS", 400);
  }
  if (!body["enabled"]) return { enabled: false, settingsVersion: body["settingsVersion"] };
  if (body["audienceType"] !== "organization" && body["audienceType"] !== "selected") {
    throw new SquareError("SQUARE_INVALID_SETTINGS", 400);
  }
  return {
    enabled: true,
    settingsVersion: body["settingsVersion"],
    audienceType: body["audienceType"],
    departmentIds: ids(body["departmentIds"]),
    userIds: ids(body["userIds"]),
  };
}

export type SquareService = ReturnType<typeof createSquareService>;
