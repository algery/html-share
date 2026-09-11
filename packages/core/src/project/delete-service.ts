import type { PlatformUserIdentity } from "../auth/contracts.js";

export type ProjectDeletionOutcome = "already_deleted" | "deleted" | "forbidden" | "not_found";

export interface AdminProjectSummary {
  createdAt: Date;
  displayName: string;
  ownerDisplayName: string;
  ownerUserId: string;
  projectKey: string;
  status: "active" | "deleted" | "pending";
  totalSize: number;
  updatedAt: Date;
}

export interface ProjectDeletionRepository {
  deleteAsAdministrator(input: {
    actorUserId: string;
    now: Date;
    projectKey: string;
    reason: string;
    requestIp: string;
    traceId: string;
  }): Promise<ProjectDeletionOutcome>;
  deleteAsOwner(input: {
    now: Date;
    ownerUserId: string;
    projectKey: string;
  }): Promise<ProjectDeletionOutcome>;
  findForAdministrator(input: { projectKey: string }): Promise<AdminProjectSummary | null>;
  recordAdministratorRateLimit(input: {
    actorUserId: string;
    now: Date;
    requestIp: string;
    traceId: string;
  }): Promise<void>;
}

export class ProjectDeletionError extends Error {
  constructor(readonly code: "ADMIN_FORBIDDEN" | "INVALID_REASON") {
    super(code);
  }
}

export function createProjectDeletionService(options: {
  administratorDingTalkUserIds: readonly string[];
  now?: () => Date;
  repository: ProjectDeletionRepository;
}) {
  const now = options.now ?? (() => new Date());
  const administrators = new Set(options.administratorDingTalkUserIds.filter(Boolean));

  return {
    isAdministrator(actor: PlatformUserIdentity) {
      return administrators.has(actor.dingtalkUserId);
    },

    deleteOwnedProject(input: { projectKey: string; userId: string }) {
      return options.repository.deleteAsOwner({
        now: now(),
        ownerUserId: input.userId,
        projectKey: input.projectKey,
      });
    },

    async deleteProjectAsAdministrator(input: {
      actor: PlatformUserIdentity;
      projectKey: string;
      reason: string;
      requestIp: string;
      traceId: string;
    }) {
      assertAdministrator(input.actor, administrators);
      const reason = normalizeReason(input.reason);
      return options.repository.deleteAsAdministrator({
        actorUserId: input.actor.id,
        now: now(),
        projectKey: input.projectKey,
        reason,
        requestIp: input.requestIp,
        traceId: input.traceId,
      });
    },

    async findProjectAsAdministrator(input: { actor: PlatformUserIdentity; projectKey: string }) {
      assertAdministrator(input.actor, administrators);
      return options.repository.findForAdministrator({ projectKey: input.projectKey });
    },

    async recordAdministratorRateLimit(input: {
      actor: PlatformUserIdentity;
      requestIp: string;
      traceId: string;
    }) {
      assertAdministrator(input.actor, administrators);
      await options.repository.recordAdministratorRateLimit({
        actorUserId: input.actor.id,
        now: now(),
        requestIp: input.requestIp,
        traceId: input.traceId,
      });
    },
  };
}

function assertAdministrator(user: PlatformUserIdentity, administrators: ReadonlySet<string>) {
  if (!administrators.has(user.dingtalkUserId)) throw new ProjectDeletionError("ADMIN_FORBIDDEN");
}

function normalizeReason(value: string) {
  const reason = value.trim();
  const length = [...reason].length;
  if (length < 10 || length > 500) throw new ProjectDeletionError("INVALID_REASON");
  return reason;
}

export type ProjectDeletionService = ReturnType<typeof createProjectDeletionService>;
