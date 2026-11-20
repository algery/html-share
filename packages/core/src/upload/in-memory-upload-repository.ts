import { randomUUID } from "node:crypto";

import { resolveHomepage } from "../project/homepage.js";

import {
  MAX_DEMOS_PER_USER,
  MAX_STORAGE_BYTES_PER_USER,
  UPLOAD_IDEMPOTENCY_TTL_MS,
  UPLOAD_URL_TTL_MS,
  type PreparedUpload,
  type UploadRepository,
  type UploadTaskSummary,
  UploadError,
} from "./contracts.js";
import {
  expireTask,
  preparePassword,
  requestFingerprint,
  taskSummary,
  toPreparedUpload,
  type PasswordCrypto,
  type PrepareInput,
  type StoredProject,
  type StoredTask,
} from "./in-memory-upload-state.js";

type TaskInput = Parameters<UploadRepository["getStatus"]>[0];

export class InMemoryUploadRepository implements UploadRepository {
  private readonly projects = new Map<string, StoredProject>();
  private readonly tasks = new Map<string, StoredTask>();
  private prepareQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: { passwordCrypto?: PasswordCrypto } = {}) {}

  prepare(input: PrepareInput): Promise<PreparedUpload> {
    const result = this.prepareQueue.then(() => this.prepareLocked(input));
    this.prepareQueue = result.catch(() => undefined);
    return result;
  }

  private async prepareLocked(input: PrepareInput): Promise<PreparedUpload> {
    for (const task of this.tasks.values()) expireTask(task, input.now);
    const existing = [...this.tasks.values()]
      .reverse()
      .find(
        (task) =>
          task.ownerUserId === input.owner.id &&
          task.createdAt.getTime() + UPLOAD_IDEMPOTENCY_TTL_MS > input.now.getTime() &&
          task.clientRequestId === input.clientRequestId,
      );
    if (existing && existing.requestFingerprint !== requestFingerprint(input))
      throw new UploadError("INVALID_UPLOAD_INPUT");
    if (existing && existing.status !== "expired" && existing.status !== "failed")
      return toPreparedUpload(existing, true);

    const projectId = input.projectId ?? existing?.projectId;
    let project = projectId === undefined ? undefined : this.projects.get(projectId);
    if (projectId !== undefined) {
      if (!project || project.deleted) throw new UploadError("PROJECT_NOT_FOUND");
      if (project.ownerUserId !== input.owner.id) throw new UploadError("PROJECT_FORBIDDEN");
      if (this.findActiveTask(project.id)) throw new UploadError("PROJECT_UPLOAD_CONFLICT");
    } else if (input.action === "replace") {
      throw new UploadError("PROJECT_NOT_FOUND");
    }
    if (!project) {
      this.assertCreateQuota(input.owner.id, input.totalSize);
      project = this.createProject(input.owner.id, input.totalSize);
    }
    const uploadId = randomUUID();
    // Generate before inserting either task or project, so errors leave no reservation.
    const password = await preparePassword(project, input, uploadId, this.options.passwordCrypto);
    // Deletion may occur while asynchronous password hashing is running.
    if (project.deleted) throw new UploadError("PROJECT_NOT_FOUND");
    const task: StoredTask = {
      ...password,
      clientRequestId: input.clientRequestId,
      coverHomepage: resolveHomepage(input.files.map((file) => file.relativePath)).path,
      requestFingerprint: requestFingerprint(input),
      createdAt: new Date(input.now),
      expiresAt: new Date(input.now.getTime() + UPLOAD_URL_TTL_MS),
      idempotent: false,
      ownerUserId: input.owner.id,
      projectId: project.id,
      revisionNumber: project.nextRevision,
      status: "prepared",
      targetHtml: input.targetHtml,
      totalSize: input.totalSize,
      files: input.files.map((file) => ({
        ...file,
        storageKey: `projects/${project.id}/revisions/${project.nextRevision}/${file.relativePath}`,
      })),
      uploadId,
    };
    project.nextRevision += 1;
    this.projects.set(project.id, project);
    this.tasks.set(uploadId, task);
    return toPreparedUpload(task, false);
  }

  async prepareCover(input: Parameters<UploadRepository["prepareCover"]>[0]) {
    const task = this.ownedTask(input);
    if (task.status === "expired") throw new UploadError("UPLOAD_EXPIRED");
    if (task.status !== "prepared" || task.coverHomepage !== input.homepagePath)
      throw new UploadError("INVALID_UPLOAD_INPUT");
    const existing = task.coverUpload;
    if (existing && (existing.contentMd5 !== input.contentMd5 || existing.size !== input.size))
      throw new UploadError("INVALID_UPLOAD_INPUT");
    const { contentMd5, homepagePath, size } = input;
    const cover = existing ?? {
      contentMd5,
      homepagePath,
      size,
      storageKey: `square-covers/${task.projectId}/${task.uploadId}.jpg`,
    };
    task.coverUpload = cover;
    return { ...cover, expiresAt: task.expiresAt };
  }

  async requestCompletion(input: TaskInput): Promise<UploadTaskSummary> {
    const task = this.ownedTask(input);
    if (task.status === "prepared") task.status = "processing";
    return taskSummary(
      task,
      this.projects.get(task.projectId),
      input.now,
      this.options.passwordCrypto,
    );
  }

  async getStatus(input: TaskInput): Promise<UploadTaskSummary> {
    const task = this.ownedTask(input);
    return taskSummary(
      task,
      this.projects.get(task.projectId),
      input.now,
      this.options.passwordCrypto,
    );
  }

  /** Test-double lifecycle operation; production publication is handled by the worker. */
  async publishUpload(input: { uploadId: string; now: Date }): Promise<boolean> {
    const task = this.tasks.get(input.uploadId);
    if (!task) return false;
    expireTask(task, input.now);
    const project = this.projects.get(task.projectId);
    if (task.status !== "processing" || !project || project.deleted) return false;
    if (project.passwordVersion !== task.passwordVersion) {
      for (const old of this.tasks.values()) {
        if (old.projectId === project.id && old.uploadId !== task.uploadId) {
          old.encryptedPasswordResult = null;
          old.passwordHash = null;
        }
      }
    }
    Object.assign(project, {
      accessMode: task.accessMode,
      passwordHash: task.passwordHash,
      passwordVersion: task.passwordVersion,
      totalSize: task.totalSize,
      active: true,
    });
    task.status = "completed";
    return true;
  }

  async failUpload(input: { uploadId: string; now: Date }): Promise<boolean> {
    const task = this.tasks.get(input.uploadId);
    if (!task) return false;
    expireTask(task, input.now);
    if (task.status !== "prepared" && task.status !== "processing") return false;
    task.status = "failed";
    task.passwordHash = null;
    task.encryptedPasswordResult = null;
    return true;
  }

  async deleteProject(input: { projectId: string; ownerUserId: string }): Promise<void> {
    const project = this.projects.get(input.projectId);
    if (!project || project.deleted) throw new UploadError("PROJECT_NOT_FOUND");
    if (project.ownerUserId !== input.ownerUserId) throw new UploadError("PROJECT_FORBIDDEN");
    project.deleted = true;
    project.passwordHash = null;
    project.passwordVersion += 1;
    for (const task of this.tasks.values()) {
      if (task.projectId !== project.id) continue;
      task.passwordHash = null;
      task.encryptedPasswordResult = null;
      if (task.status === "prepared" || task.status === "processing") task.status = "failed";
    }
  }

  private ownedTask(input: TaskInput): StoredTask {
    const task = this.tasks.get(input.uploadId);
    if (!task || task.ownerUserId !== input.ownerUserId) throw new UploadError("UPLOAD_NOT_FOUND");
    expireTask(task, input.now);
    return task;
  }

  private assertCreateQuota(ownerUserId: string, requestedBytes: number) {
    const projects = [...this.projects.values()].filter(
      (project) => project.ownerUserId === ownerUserId && !project.deleted,
    );
    if (projects.length >= MAX_DEMOS_PER_USER) throw new UploadError("PROJECT_QUOTA_EXCEEDED");
    const usedBytes = projects.reduce((sum, project) => sum + project.totalSize, 0);
    if (usedBytes + requestedBytes > MAX_STORAGE_BYTES_PER_USER)
      throw new UploadError("STORAGE_QUOTA_EXCEEDED");
  }

  private createProject(ownerUserId: string, totalSize: number): StoredProject {
    let id = "";
    while (id.length === 0 || this.projects.has(id))
      id = randomUUID().replaceAll("-", "").slice(0, 5);
    return {
      id,
      nextRevision: 1,
      ownerUserId,
      totalSize,
      accessMode: "organization",
      passwordHash: null,
      passwordVersion: 0,
      active: false,
      deleted: false,
    };
  }

  private findActiveTask(projectId: string) {
    return [...this.tasks.values()].find(
      (task) =>
        task.projectId === projectId &&
        (task.status === "prepared" || task.status === "processing"),
    );
  }
}
