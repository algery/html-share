import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as core from "../packages/core/dist/index.js";
import * as db from "../packages/db/dist/index.js";
import { createSimulatorDingTalkClient } from "../packages/dingtalk/dist/index.js";
import { createObjectStore, observeObjectStoreActivity } from "../packages/storage/dist/index.js";
import { buildServerApp } from "../apps/server/dist/app.js";
import { finalizeNextUpload } from "../apps/worker/dist/jobs/finalize-upload.js";
import { createSmokeAuthorization } from "./password-smoke-auth.mjs";
const appRequire = createRequire(new URL("../apps/server/package.json", import.meta.url));
const storageRequire = createRequire(new URL("../packages/storage/package.json", import.meta.url));
const { Client, StreamableHTTPClientTransport } = await import(
  pathToFileURL(appRequire.resolve("@modelcontextprotocol/client")).href
);
const { S3Client, DeleteBucketCommand } = await import(
  pathToFileURL(storageRequire.resolve("@aws-sdk/client-s3")).href
);

export { isolatedConfiguration, fixture } from "./password-smoke-fixture.mjs";

export async function createHarness(config, check, options = {}) {
  const prisma = db.createPrismaClient(config.databaseUrl);
  const bucket = `password-smoke-${randomUUID()}`;
  const storeConfig = { ...config, bucket, provider: "minio", region: "us-east-1" };
  const rawStorage = createObjectStore(storeConfig);
  const serverStorage = observeObjectStoreActivity(rawStorage);
  const workerStorage = observeObjectStoreActivity(rawStorage);
  process.env.PASSWORD_RESULT_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.PASSWORD_MANAGEMENT_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const rawCrypto = core.createPasswordCrypto(process.env.PASSWORD_RESULT_ENCRYPTION_KEY);
  const managementCrypto = core.createPasswordCrypto(
    process.env.PASSWORD_MANAGEMENT_ENCRYPTION_KEY,
  );
  const hashActivity = { generate: 0, verify: 0 };
  const crypto = {
    ...rawCrypto,
    generate(...args) {
      hashActivity.generate++;
      return rawCrypto.generate(...args);
    },
    verify(...args) {
      hashActivity.verify++;
      return rawCrypto.verify(...args);
    },
  };
  const repository = db.createUploadRepository(prisma, {
    passwordCrypto: crypto,
    passwordManagementCrypto: managementCrypto,
  });
  const states = [];
  const clients = [];
  let tenantId;
  let app;
  let bucketCreated = false;
  const contentActivity = { getObjectCalls: 0, bodyBytesRead: 0 };
  const trace = [];
  async function cleanup() {
    const errors = [];
    for (const operation of [
      async () => {
        for (const client of clients) await client.close();
      },
      async () => {
        if (app) await app.close();
      },
      async () => {
        if (!bucketCreated) return;
        let page;
        do {
          page = await rawStorage.listObjects({ maxKeys: 1000 });
          await rawStorage.deleteObjects(page.keys);
        } while (page.keys.length > 0);
        const client = new S3Client({
          endpoint: config.endpoint,
          region: "us-east-1",
          forcePathStyle: true,
          credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.accessKeySecret },
        });
        try {
          await client.send(new DeleteBucketCommand({ Bucket: bucket }));
        } finally {
          client.destroy();
        }
      },
      async () => {
        if (tenantId) {
          const records = await Promise.all(
            [prisma.demoProject, prisma.uploadTask, prisma.revision].map((model) =>
              model.findMany({ where: { tenantId }, select: { id: true } }),
            ),
          );
          await prisma.cleanupJob.deleteMany({
            where: { targetId: { in: records.flat().map((x) => x.id) } },
          });
          await prisma.demoProject.deleteMany({ where: { tenantId } });
          await prisma.user.deleteMany({ where: { tenantId } });
          await prisma.tenant.delete({ where: { id: tenantId } });
        }
        await prisma.authState.deleteMany({ where: { stateDigest: { in: states } } });
      },
      async () => {
        await prisma.$disconnect();
      },
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(`isolated smoke cleanup failed (${error?.code ?? error?.name ?? "unknown"})`);
      }
    }
    if (errors.length) throw new Error(errors.join("; "));
  }
  try {
    await rawStorage.ensurePrivateBucket();
    bucketCreated = true;
    const appKey = `password-smoke-${randomUUID()}`;
    tenantId = (
      await prisma.tenant.create({ data: { name: "Password smoke", dingtalkAppKeyRef: appKey } })
    ).id;
    const { appAuthorization, authorization, session, sessions } = await createSmokeAuthorization({
      appKey,
      check,
      prisma,
      states,
    });
    const tokens = core.createMcpTokenService({
      repository: db.createMcpTokenRepository(prisma),
      hashSecret: randomBytes(32).toString("base64"),
    });
    const token = await tokens.createToken({ name: "Password smoke", user: session.user });
    const address = options.appUrl ?? "http://127.0.0.1:55100";
    const appWebUrl = options.appWebUrl ?? address;
    const demoUrl = options.demoUrl ?? "http://localhost:55100";
    const projectReader = db.createProjectReader(prisma);
    const passwordManagement = core.createPasswordManagementService({
      passwordCrypto: managementCrypto,
      repository: db.createPasswordManagementRepository(prisma),
    });
    app = buildServerApp({
      appAuthUrl: address,
      appHost: new URL(address).hostname,
      appWebUrl,
      demoAuthUrl: demoUrl,
      demoHost: new URL(demoUrl).hostname,
      demoWebUrl: demoUrl,
      demoInAppClientId: "password-test-client",
      demoInAppCorpId: "password-test-corp",
      authSessions: sessions,
      dingtalk: createSimulatorDingTalkClient(),
      logger: options.logger ?? false,
      trustProxy: ["127.0.0.1"],
      ...(options.passwordAccess
        ? {
            passwordStateSecret: randomBytes(32).toString("base64"),
            passwordAccess: core.createPasswordAccessService({
              repository: db.createPasswordAccessRepository(prisma),
              passwordCrypto: crypto,
            }),
          }
        : {}),
      mcpTokens: tokens,
      passwordManagement,
      projectDeletion: core.createProjectDeletionService({
        administratorDingTalkUserIds: [],
        repository: db.createProjectDeletionRepository(prisma),
      }),
      projectManagement: projectReader,
      projects: projectReader,
      storage: serverStorage.storage,
      uploads: core.createUploadService({ repository }),
      rateLimits: options.defaultRateLimits
        ? undefined
        : {
            authPerMinute: 1000,
            contentIpPerMinute: 1000,
            contentSessionPerMinute: 1000,
            mcpPerMinute: 1000,
            mcpUploadCompletePerMinute: 1000,
            mcpUploadPreparePerMinute: 1000,
          },
    });
    await app.listen({ host: "127.0.0.1", port: 55100 });
    async function connect(value) {
      const client = new Client({ name: "password-publication-smoke", version: "1.0.0" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL("/mcp", address), {
          requestInit: { headers: { Authorization: `Bearer ${value}` } },
        }),
      );
      return client;
    }
    const client = await connect(token.token);
    async function call(name, args, expectedError, selectedClient = client) {
      const response = await selectedClient.callTool({ name, arguments: args });
      const text = response.content?.find((item) => item.type === "text")?.text;
      check(typeof text === "string", "MCP JSON response exists");
      const result = JSON.parse(text);
      check(
        expectedError
          ? response.isError === true && result.error === expectedError
          : response.isError !== true,
        expectedError ? `MCP rejects ${expectedError}` : `MCP ${name} succeeds`,
      );
      return result;
    }
    async function read(result, bodies) {
      const before = serverStorage.snapshot();
      for (const [path, body] of bodies) {
        const target = `/${result.project_id}/${path.split("/").map(encodeURIComponent).join("/")}`;
        const response = await fetch(demoUrl + target, {
          headers: {
            cookie: `html_share_demo_session=${authorization.token}`,
          },
          signal: AbortSignal.timeout(10_000),
        });
        check(
          response.status === 200,
          `organization session reads published file (${response.status})`,
        );
        check(
          Buffer.from(await response.arrayBuffer()).equals(body),
          "published bytes match exactly",
        );
      }
      const after = serverStorage.snapshot();
      contentActivity.getObjectCalls += after.getObjectCalls - before.getObjectCalls;
      contentActivity.bodyBytesRead += after.bodyBytesRead - before.bodyBytesRead;
    }
    async function finalize() {
      check(
        (await prisma.uploadTask.count({
          where: { status: "PROCESSING", tenantId: { not: tenantId } },
        })) === 0,
        "no unrelated processing upload may be claimed",
      );
      return finalizeNextUpload({
        repository,
        storage: workerStorage.storage,
        onOutcome: (outcome) => trace.push({ status: outcome.status, trace_id: outcome.traceId }),
      });
    }
    function publicationMetrics() {
      const server = serverStorage.snapshot();
      const worker = workerStorage.snapshot();
      return {
        server: {
          getObjectCalls: server.getObjectCalls - contentActivity.getObjectCalls,
          bodyBytesRead: server.bodyBytesRead - contentActivity.bodyBytesRead,
        },
        worker,
        content: { ...contentActivity },
      };
    }
    return {
      app,
      appCookie: `html_share_app_session=${appAuthorization.token}`,
      appCsrfToken: sessions.createCsrfToken({
        audience: "app",
        token: appAuthorization.token,
      }),
      appSessionToken: appAuthorization.token,
      appWebUrl,
      bucket,
      call,
      cleanup,
      crypto,
      demoUrl,
      mcpUrl: new URL("/mcp", address).toString(),
      mcpToken: token.token,
      finalize,
      prisma,
      read,
      publicationMetrics,
      trace,
      tenantId,
      hashActivity,
      managementCrypto,
      ownerUserId: session.user.id,
      async otherClient() {
        const user = await prisma.user.create({
          data: {
            tenantId,
            dingtalkUserId: randomUUID(),
            displayName: "Other smoke owner",
            lastLoginAt: new Date(),
          },
        });
        return connect((await tokens.createToken({ name: "Other smoke owner", user })).token);
      },
    };
  } catch (error) {
    await cleanup();
    throw new Error(`isolated smoke setup failed (${error?.code ?? error?.name ?? "unknown"})`);
  }
}
