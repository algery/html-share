import { randomUUID } from "node:crypto";

import {
  MAX_DEMOS_PER_USER,
  MAX_STORAGE_BYTES_PER_USER,
  UPLOAD_IDEMPOTENCY_TTL_MS,
  UPLOAD_URL_TTL_MS,
  type PrepareDemoUploadInput,
  type PreparedUpload,
  type UploadRepository,
  type UploadTaskStatus,
  UploadError,
  type UploadTaskSummary,
} from "./contracts.js";
import { createTemporaryObjectKey } from "./upload-service.js";

interface StoredProject {
  id: string;
  ownerUserId: string;
  totalSize: number;
}

interface StoredTask extends Omit<PreparedUpload, "status"> {
  action: "create" | "replace";
  clientRequestId: string;
  ownerUserId: string;
  status: UploadTaskStatus;
  createdAt: Date;
}

export class InMemoryUploadRepository implements UploadRepository {
  private readonly projects = new Map<string, StoredProject>();
  private readonly tasks = new Map<string, StoredTask>();

  async prepare(
    input: PrepareDemoUploadInput & { owner: { id: string }; now: Date },
  ): Promise<PreparedUpload> {
    const existing = [...this.tasks.values()].find(
      (task) =>
        task.ownerUserId === input.owner.id &&
        task.createdAt.getTime() + UPLOAD_IDEMPOTENCY_TTL_MS > input.now.getTime() &&
        task.clientRequestId === input.clientRequestId,
    );
    if (
      existing !== undefined &&
      existing.expiresAt <= input.now &&
      existing.status === "prepared"
    ) {
      existing.status = "expired";
    }
    if (
      existing !== undefined &&
      (existing.status === "completed" || existing.status === "processing")
    ) {
      return toPreparedUpload(existing, true);
    }
    if (existing !== undefined && existing.status !== "expired" && existing.status !== "failed") {
      return toPreparedUpload(existing, true);
    }

    const project =
      input.projectId === undefined
        ? existing === undefined
          ? undefined
          : this.projects.get(existing.projectId)
        : this.projects.get(input.projectId);
    if (input.action === "replace") {
      if (project === undefined) throw new UploadError("PROJECT_NOT_FOUND");
      if (project.ownerUserId !== input.owner.id) throw new UploadError("PROJECT_FORBIDDEN");
      if (this.findActiveTask(project.id) !== undefined)
        throw new UploadError("PROJECT_UPLOAD_CONFLICT");
    }
    if (input.action === "create") this.assertCreateQuota(input.owner.id, input.totalSize);

    const projectId = project?.id ?? this.createProject(input.owner.id, input.totalSize);
    const uploadId = randomUUID();
    const task: StoredTask = {
      action: input.action,
      archiveSize: input.archiveSize,
      clientRequestId: input.clientRequestId,
      createdAt: input.now,
      expiresAt: new Date(input.now.getTime() + UPLOAD_URL_TTL_MS),
      idempotent: false,
      ownerUserId: input.owner.id,
      projectId,
      status: "prepared",
      temporaryObjectKey: createTemporaryObjectKey(uploadId),
      uploadId,
    };
    this.tasks.set(uploadId, task);
    return toPreparedUpload(task, false);
  }

  async requestCompletion(input: {
    ownerUserId: string;
    uploadId: string;
    now: Date;
  }): Promise<UploadTaskSummary> {
    const task = this.tasks.get(input.uploadId);
    if (task === undefined || task.ownerUserId !== input.ownerUserId)
      throw new UploadError("UPLOAD_NOT_FOUND");
    if (task.status === "prepared" && task.expiresAt <= input.now) task.status = "expired";
    if (task.status === "prepared") task.status = "processing";
    return {
      expiresAt: task.expiresAt,
      projectId: task.projectId,
      status: task.status,
      uploadId: task.uploadId,
    };
  }

  async getStatus(input: {
    ownerUserId: string;
    uploadId: string;
    now: Date;
  }): Promise<UploadTaskSummary> {
    const task = this.tasks.get(input.uploadId);
    if (task === undefined || task.ownerUserId !== input.ownerUserId)
      throw new UploadError("UPLOAD_NOT_FOUND");
    if (task.status === "prepared" && task.expiresAt <= input.now) task.status = "expired";
    return {
      expiresAt: task.expiresAt,
      projectId: task.projectId,
      status: task.status,
      uploadId: task.uploadId,
    };
  }

  private assertCreateQuota(ownerUserId: string, requestedBytes: number) {
    const projects = [...this.projects.values()].filter(
      (project) => project.ownerUserId === ownerUserId,
    );
    if (projects.length >= MAX_DEMOS_PER_USER) throw new UploadError("PROJECT_QUOTA_EXCEEDED");
    const usedBytes = projects.reduce((sum, project) => sum + project.totalSize, 0);
    if (usedBytes + requestedBytes > MAX_STORAGE_BYTES_PER_USER) {
      throw new UploadError("STORAGE_QUOTA_EXCEEDED");
    }
  }

  private createProject(ownerUserId: string, totalSize: number) {
    let id = "";
    while (id.length === 0 || this.projects.has(id)) id = randomProjectKey();
    this.projects.set(id, { id, ownerUserId, totalSize });
    return id;
  }

  private findActiveTask(projectId: string) {
    return [...this.tasks.values()].find(
      (task) =>
        task.projectId === projectId &&
        (task.status === "prepared" || task.status === "processing"),
    );
  }
}

function toPreparedUpload(task: StoredTask, idempotent: boolean): PreparedUpload {
  return {
    archiveSize: task.archiveSize,
    expiresAt: task.expiresAt,
    idempotent,
    projectId: task.projectId,
    status:
      task.status === "completed"
        ? "completed"
        : task.status === "processing"
          ? "processing"
          : "prepared",
    temporaryObjectKey: task.temporaryObjectKey,
    uploadId: task.uploadId,
  };
}

function randomProjectKey() {
  return randomUUID()
    .replaceAll("-", "")
    .slice(0, 5)
    .replace(/[^a-z0-9]/g, "a");
}
