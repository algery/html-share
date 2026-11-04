import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import {
  createPasswordAccessService,
  createPasswordCrypto,
  createPasswordManagementService,
  createProjectDeletionService,
} from "../packages/core/dist/index.js";
import { createDatabaseRepositories } from "../packages/db/dist/index.js";
import { createObjectStore } from "../packages/storage/dist/index.js";
import { runNextCleanupJob } from "../apps/worker/dist/jobs/cleanup-storage.js";

const storageRequire = createRequire(new URL("../packages/storage/package.json", import.meta.url));
const { S3Client, DeleteBucketCommand } = await import(
  pathToFileURL(storageRequire.resolve("@aws-sdk/client-s3")).href
);
const hash = (body) => createHash("sha256").update(body).digest("hex");
const readBody = async (storage, key) => {
  const chunks = [];
  for await (const chunk of await storage.getObject(key)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

async function databaseName(connection) {
  const rows =
    connection.provider === "mysql"
      ? await connection.client.$queryRaw`SELECT DATABASE() AS name`
      : await connection.client.$queryRaw`SELECT current_database() AS name`;
  return rows[0]?.name;
}

async function removeRestoreBucket(storage, config, bucket, uploadedKeys) {
  await storage.deleteObjects(uploadedKeys);
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.accessKeySecret },
  });
  try {
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (error?.name !== "NoSuchBucket") throw new Error("Isolated restore bucket cleanup failed");
  } finally {
    client.destroy();
  }
}

// Only this dedicated restored database and a new bucket may receive writes.
// Body downloads here belong to backup/restore, never publication metadata work.
export async function verifyRestoredBusiness({ provider, source, restored }) {
  assert.equal(process.env.PHASE26_IMAGE_TEST_ISOLATED, "1", "Explicit isolation required");
  assert(["postgresql", "mysql"].includes(provider), "Unsupported isolated provider");
  assert.equal(source.provider, provider);
  assert.equal(restored.provider, provider);
  assert.equal(await databaseName(source), "html_share_phase26_image");
  assert.equal(await databaseName(restored), "html_share_phase26_restore");
  const defaults = parseEnv(await readFile(new URL("../.env.example", import.meta.url), "utf8"));
  const passwordCrypto = createPasswordCrypto(defaults.PASSWORD_RESULT_ENCRYPTION_KEY);
  const managementCrypto = createPasswordCrypto(defaults.PASSWORD_MANAGEMENT_ENCRYPTION_KEY);
  const repositories = createDatabaseRepositories(restored);
  const sourceRepositories = createDatabaseRepositories(source);
  const access = createPasswordAccessService({
    passwordCrypto,
    repository: repositories.passwordAccess,
  });
  const management = createPasswordManagementService({
    passwordCrypto: managementCrypto,
    repository: repositories.passwordManagement,
  });
  const sourceManagement = createPasswordManagementService({
    passwordCrypto: managementCrypto,
    repository: sourceRepositories.passwordManagement,
  });
  const candidates = await restored.client.demoProject.findMany({
    where: {
      status: "ACTIVE",
      accessMode: "password",
      currentRevision: { is: { status: "ACTIVE", files: { some: {} } } },
    },
    include: { currentRevision: { include: { files: true } } },
  });
  const project = candidates.find((candidate) =>
    candidate.currentRevision.files.some((file) => /[^\u0020-\u007e]/u.test(file.relativePath)),
  );
  assert(project, "An active password project with a Unicode file must survive restore");
  assert(project.passwordHash && project.encryptedPassword, "Restored password material required");
  const file = project.currentRevision.files.find((item) =>
    /[^\u0020-\u007e]/u.test(item.relativePath),
  );
  assert(file?.storageKey && file.contentHash && file.size > 0n, "Restored file material required");
  const owned = { ownerUserId: project.ownerUserId, projectKey: project.projectKey };
  const path = { projectKey: project.projectKey, relativePath: file.relativePath };
  const sourceBefore = await source.client.demoProject.findUnique({
    where: { id: project.id },
    include: { currentRevision: { include: { files: { orderBy: { id: "asc" } } } } },
  });
  assert(sourceBefore?.status === "ACTIVE", "Source project must remain active");
  const detail = await repositories.projects.findOwnedActiveProject(owned);
  assert(
    detail?.files.some((item) => item.relativePath === file.relativePath),
    "Owned detail exists",
  );
  const password = await management.readOwnedProjectAccess(owned);
  const sourcePassword = await sourceManagement.readOwnedProjectAccess(owned);
  assert(password?.accessPassword && sourcePassword?.accessPassword, "Owned passwords readable");
  assert(password.accessPassword === sourcePassword.accessPassword, "Restored password preserved");
  const grant = await access.verifyPassword({ ...path, password: password.accessPassword });
  assert(grant, "Restored password must issue a real grant");
  const authorized = await access.authorize({ ...path, token: grant.token });
  assert(authorized?.file.relativePath === file.relativePath, "Grant authorizes the exact path");
  assert(authorized.file.storageKey === file.storageKey, "Grant selects the restored object key");
  const sourceFile = await sourceRepositories.projects.findCurrentFile({
    ...path,
    tenantId: project.tenantId,
  });
  assert(sourceFile?.storageKey === file.storageKey, "Source path selects the same object key");
  const config = {
    provider: "minio",
    endpoint: "http://127.0.0.1:59000",
    region: "us-east-1",
    accessKeyId: "password_test",
    accessKeySecret: "local-password-test-only",
  };
  const sourceBucket = `phase26-image-${provider}`;
  const bucket = `phase26-restore-${provider}-${randomUUID()}`;
  assert(bucket !== sourceBucket, "Source and restored storage must be isolated");
  const sourceStorage = createObjectStore({ ...config, bucket: sourceBucket });
  const storage = createObjectStore({ ...config, bucket });
  const uploadedKeys = [];
  let bucketStarted = false;
  try {
    const sourceBody = await readBody(sourceStorage, sourceFile.storageKey);
    assert(sourceBody.length === sourceFile.size, "Source body length matches restored metadata");
    assert(hash(sourceBody) === file.contentHash, "Source body hash matches restored metadata");
    bucketStarted = true;
    await storage.ensurePrivateBucket();
    const upload = await storage.createPresignedUpload({
      key: file.storageKey,
      contentLength: sourceBody.length,
      contentType: "text/html; charset=utf-8",
      contentMd5: createHash("md5").update(sourceBody).digest("base64"),
      expiresInSeconds: 60,
    });
    // Track before upload so ambiguous network failures still clean this key.
    uploadedKeys.push(file.storageKey);
    const response = await fetch(upload.url, {
      method: "PUT",
      headers: upload.headers,
      body: sourceBody,
      signal: AbortSignal.timeout(15_000),
    });
    assert(response.ok, "Restored body upload succeeds");
    const restoredBody = await readBody(storage, authorized.file.storageKey);
    assert(hash(restoredBody) === file.contentHash, "Restored access reads the exact body hash");
    assert(restoredBody.equals(sourceBody), "Source and restored bodies match exactly");

    const deletedAt = new Date();
    const tasks = await restored.client.uploadTask.findMany({ select: { expiresAt: true } });
    const latestExpiresAt = tasks.reduce(
      (latest, task) => Math.max(latest, task.expiresAt.getTime()),
      deletedAt.getTime(),
    );
    const cleanupAt = new Date(latestExpiresAt + 60_001);
    const deletion = createProjectDeletionService({
      administratorDingTalkUserIds: [],
      now: () => deletedAt,
      repository: repositories.deletion,
    });
    assert.equal(
      await deletion.deleteOwnedProject({
        projectKey: project.projectKey,
        userId: project.ownerUserId,
      }),
      "deleted",
    );
    assert(
      (await access.authorize({ ...path, token: grant.token })) === null,
      "Deletion denies grant",
    );
    assert(
      (await access.authorize({ ...path, tenantId: project.tenantId })) === null,
      "Deletion denies organization access immediately",
    );
    const cleanupLimit =
      (await restored.client.cleanupJob.count()) +
      (await restored.client.revision.count()) +
      (await restored.client.uploadTask.count()) +
      (await restored.client.authState.count()) +
      10;
    let cleanupJobsCompleted = 0;
    for (let attempt = 0; attempt < cleanupLimit; attempt++) {
      const outcome = await runNextCleanupJob({
        repository: repositories.cleanup,
        storage,
        now: () => cleanupAt,
      });
      assert(outcome !== "retry", "Restored storage cleanup must succeed");
      if (outcome === "idle") break;
      cleanupJobsCompleted++;
    }
    assert(cleanupJobsCompleted > 0, "Real restored cleanup jobs must run");
    const cleanupJob = await restored.client.cleanupJob.findFirst({
      where: { kind: "PROJECT", targetId: project.id, status: "COMPLETED" },
    });
    assert(cleanupJob, "Project cleanup completes after actual upload expiry plus grace");
    assert((await storage.headObject(file.storageKey)) === null, "Worker deletes restored object");
    const sourceAfter = await source.client.demoProject.findUnique({
      where: { id: project.id },
      include: { currentRevision: { include: { files: { orderBy: { id: "asc" } } } } },
    });
    // Compare as booleans so assertion failures never print encrypted/password fields.
    const serialize = (value) =>
      JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
    assert(serialize(sourceAfter) === serialize(sourceBefore), "Source project metadata unchanged");
    const sourceAfterFile = await sourceRepositories.projects.findCurrentFile({
      ...path,
      tenantId: project.tenantId,
    });
    assert(sourceAfterFile?.storageKey === sourceFile.storageKey, "Source access remains readable");
    assert(
      (await readBody(sourceStorage, sourceAfterFile.storageKey)).equals(sourceBody),
      "Source bytes unchanged",
    );
    return {
      activePasswordProject: true,
      passwordGrantVerified: true,
      exactPathBodyVerified: true,
      deletedAccessDenied: true,
      restoredObjectsCleaned: true,
      sourceObjectsUnchanged: true,
      sourceDatabaseUnchanged: true,
      restoredObjects: uploadedKeys.length,
      backupBodyBytes: sourceBody.length,
      cleanupJobsCompleted,
    };
  } finally {
    if (bucketStarted) await removeRestoreBucket(storage, config, bucket, uploadedKeys);
  }
}
