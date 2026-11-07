import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe } from "vitest";

import {
  createPasswordCrypto,
  createPasswordAccessService,
  createPasswordManagementService,
  createUploadService,
  digestManifest,
  mimeForPath,
} from "../packages/core/dist/index.js";
import { createDatabaseRepositories } from "../packages/db/src/database-repositories.ts";
import {
  createDatabaseFixture,
  readContractDatabases,
} from "../packages/db/src/testing/database-fixture.ts";

const enabled = Boolean(
  process.env.PHASE25_CONTRACT_REQUIRED ||
  process.env.PHASE25_POSTGRES_URL ||
  process.env.PHASE25_MYSQL_URL,
);
// A partially configured matrix is always an error, including ordinary vitest runs.
if (enabled) readContractDatabases();

export function databaseContract(name, definitions) {
  for (const provider of ["postgresql", "mysql"]) {
    (enabled ? describe : describe.skip)(`Phase 25 ${provider}: ${name}`, () => {
      let fixture;
      beforeEach(async () => {
        fixture = await createContractFixture(provider);
      });
      afterEach(async () => {
        await fixture?.cleanup();
      });
      definitions(() => fixture);
    });
  }
}

export function manifest(paths = ["index.html"], size = 3) {
  return paths.map((relativePath) => ({
    relativePath,
    size,
    sha256: "a".repeat(64),
    contentMd5: "kAFQmDzST7DWlj99KOF/cg==",
    mimeType: mimeForPath(relativePath),
  }));
}

async function createContractFixture(provider) {
  const connection = createDatabaseFixture(provider);
  const observer = createDatabaseFixture(provider);
  const db = connection.client;
  const crypto = createPasswordCrypto(randomBytes(32).toString("base64"));
  const managementCrypto = createPasswordCrypto(randomBytes(32).toString("base64"));
  const options = { passwordCrypto: crypto, passwordManagementCrypto: managementCrypto };
  const repositories = createDatabaseRepositories(connection, options);
  const second = createDatabaseRepositories(observer, options);
  const marker = randomUUID();
  const tenant = await db.tenant.create({
    data: { name: "Phase 25 契约😀", dingtalkAppKeyRef: marker },
  });
  const owner = await db.user.create({
    data: {
      tenantId: tenant.id,
      dingtalkUserId: marker,
      displayName: "发布者😀",
      lastLoginAt: new Date(),
    },
  });
  const stateDigests = [];
  const targets = [];
  let now = new Date();
  const service = createUploadService({ repository: repositories.uploads, now: () => now });
  const management = createPasswordManagementService({
    passwordCrypto: managementCrypto,
    repository: repositories.passwordManagement,
    now: () => now,
  });
  const access = createPasswordAccessService({
    repository: repositories.passwordAccess,
    passwordCrypto: crypto,
    now: () => now,
  });
  function request(overrides = {}) {
    const files = overrides.files ?? manifest();
    return {
      action: "create",
      clientRequestId: randomUUID(),
      displayName: "契约发布😀",
      files,
      manifestDigest: digestManifest(files),
      owner,
      targetHtml: files.find((file) => /\.html?$/i.test(file.relativePath))?.relativePath,
      ...overrides,
    };
  }
  async function ready(prepared, ownerUserId = owner.id) {
    await service.complete({ ownerUserId, uploadId: prepared.uploadId });
    await repositories.uploads.markUploadFilesVerified({ uploadId: prepared.uploadId, now });
    const task = await db.uploadTask.findUniqueOrThrow({ where: { id: prepared.uploadId } });
    targets.push(task.id, task.revisionId, task.projectId);
    return task;
  }
  async function publish(prepared, ownerUserId = owner.id) {
    await ready(prepared, ownerUserId);
    if (!(await repositories.uploads.publishUpload({ uploadId: prepared.uploadId, now }))) {
      throw new Error("Contract fixture publication unexpectedly failed");
    }
    return service.status({ ownerUserId, uploadId: prepared.uploadId });
  }
  async function project(overrides = {}) {
    const prepared = await service.prepare(request(overrides));
    const result = await publish(prepared, overrides.owner?.id);
    const stored = await db.demoProject.findUniqueOrThrow({
      where: { projectKey: prepared.projectId },
    });
    return { prepared, result, stored };
  }
  async function seedActive(count, totalSize = 0n) {
    const keys = [];
    for (let index = 0; index < count; index += 1) {
      const row = await db.demoProject.create({
        data: {
          tenantId: tenant.id,
          ownerUserId: owner.id,
          projectKey: randomUUID().replaceAll("-", "").slice(0, 5),
          displayName: "Quota fixture",
          status: "ACTIVE",
          totalSize,
        },
      });
      keys.push(row.projectKey);
    }
    return keys;
  }
  return {
    provider,
    connection,
    observer,
    db,
    repositories,
    second,
    owner,
    tenant,
    crypto,
    managementCrypto,
    management,
    access,
    service,
    stateDigests,
    targets,
    request,
    ready,
    publish,
    project,
    seedActive,
    get now() {
      return now;
    },
    setNow(value) {
      now = value;
    },
    async cleanup() {
      try {
        const [projects, revisions, tasks, states, users] = await Promise.all([
          db.demoProject.findMany({ where: { tenantId: tenant.id }, select: { id: true } }),
          db.revision.findMany({ where: { tenantId: tenant.id }, select: { id: true } }),
          db.uploadTask.findMany({ where: { tenantId: tenant.id }, select: { id: true } }),
          db.authState.findMany({
            where: { stateDigest: { in: stateDigests } },
            select: { id: true },
          }),
          db.user.findMany({ where: { tenantId: tenant.id }, select: { id: true } }),
        ]);
        const ids = [...projects, ...revisions, ...tasks, ...states].map((row) => row.id);
        await db.cleanupJob.deleteMany({ where: { targetId: { in: [...ids, ...targets] } } });
        await db.auditLog.deleteMany({ where: { actorUserId: { in: users.map((u) => u.id) } } });
        await db.authState.deleteMany({ where: { stateDigest: { in: stateDigests } } });
        await db.demoProject.deleteMany({ where: { tenantId: tenant.id } });
        await db.user.deleteMany({ where: { tenantId: tenant.id } });
        await db.tenant.delete({ where: { id: tenant.id } });
      } finally {
        await Promise.all([db.$disconnect(), observer.client.$disconnect()]);
      }
    },
  };
}
