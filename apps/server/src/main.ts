import { EnvironmentValidationError, readDingTalkEnv, readServerEnv } from "@html-share/config";
import {
  createAuthSessionService,
  createMcpTokenService,
  createProjectDeletionService,
  createUploadService,
  createPasswordCrypto,
  createPasswordAccessService,
  createPasswordManagementService,
} from "@html-share/core";
import {
  createAuthRepository,
  createPasswordAccessRepository,
  createPasswordManagementRepository,
  createMcpTokenRepository,
  createProjectDeletionRepository,
  createProjectReader,
  createPrismaClient,
  createUploadRepository,
} from "@html-share/db";
import { createLiveDingTalkClient, createSimulatorDingTalkClient } from "@html-share/dingtalk";
import { createObjectStore } from "@html-share/storage";

import { buildServerApp } from "./app.js";

function loadEnvironment() {
  try {
    return { dingtalk: readDingTalkEnv(process.env), server: readServerEnv(process.env) };
  } catch (error) {
    const message =
      error instanceof EnvironmentValidationError ? error.message : "Invalid environment variables";
    console.error(message);
    process.exit(1);
  }
}

const environment = loadEnvironment();
if (environment.server.DATABASE_PROVIDER === "mysql") {
  console.error("DATABASE_PROVIDER: MySQL business repositories are unavailable until Phase 25");
  process.exit(1);
}
const prisma = createPrismaClient(environment.server.DATABASE_URL);
const storage = createObjectStore({
  accessKeyId: environment.server.OBJECT_STORAGE_ACCESS_KEY_ID,
  accessKeySecret: environment.server.OBJECT_STORAGE_ACCESS_KEY_SECRET,
  bucket: environment.server.OBJECT_STORAGE_BUCKET,
  endpoint: environment.server.OBJECT_STORAGE_ENDPOINT,
  provider: environment.server.OBJECT_STORAGE_PROVIDER,
  region: environment.server.OBJECT_STORAGE_REGION,
  ...(environment.server.OBJECT_STORAGE_PUBLIC_ENDPOINT === undefined
    ? {}
    : { publicEndpoint: environment.server.OBJECT_STORAGE_PUBLIC_ENDPOINT }),
});
const dingtalk =
  environment.dingtalk.DINGTALK_AUTH_MODE === "simulator"
    ? createSimulatorDingTalkClient()
    : createLiveDingTalkClient({
        apiBaseUrl: environment.dingtalk.DINGTALK_API_BASE_URL,
        clientId: environment.dingtalk.DINGTALK_CLIENT_ID,
        clientSecret: environment.dingtalk.DINGTALK_CLIENT_SECRET,
        externalAuthorizeUrl: environment.dingtalk.DINGTALK_EXTERNAL_AUTHORIZE_URL,
      });
const projects = createProjectReader(prisma);
const projectDeletion = createProjectDeletionService({
  administratorDingTalkUserIds: readAdministratorIds(environment.server.ADMIN_DINGTALK_USER_IDS),
  repository: createProjectDeletionRepository(prisma),
});
const passwordCrypto = createPasswordCrypto(environment.server.PASSWORD_RESULT_ENCRYPTION_KEY);
const passwordManagementCrypto = createPasswordCrypto(
  environment.server.PASSWORD_MANAGEMENT_ENCRYPTION_KEY,
);
const passwordManagement = createPasswordManagementService({
  passwordCrypto: passwordManagementCrypto,
  repository: createPasswordManagementRepository(prisma),
});
const app = buildServerApp({
  passwordStateSecret: environment.server.AUTH_STATE_SECRET,
  passwordAccess: createPasswordAccessService({
    repository: createPasswordAccessRepository(prisma),
    passwordCrypto,
  }),
  passwordManagement,
  passwordRateLimits: {
    ipPerMinute: environment.server.PASSWORD_VERIFY_IP_RATE_LIMIT_PER_MINUTE,
    ipProjectPerMinute: environment.server.PASSWORD_VERIFY_IP_PROJECT_RATE_LIMIT_PER_MINUTE,
    projectPerMinute: environment.server.PASSWORD_VERIFY_PROJECT_RATE_LIMIT_PER_MINUTE,
  },
  appAuthUrl: environment.server.APP_AUTH_URL,
  appHost: environment.server.APP_HOST,
  appWebUrl: environment.server.APP_WEB_URL,
  authSessions: createAuthSessionService({
    repository: createAuthRepository(prisma),
    stateSecret: environment.server.AUTH_STATE_SECRET,
    tenantAppKeyRef: environment.dingtalk.DINGTALK_APP_ID ?? "simulator-dingtalk-app",
  }),
  demoAuthUrl: environment.server.DEMO_AUTH_URL,
  demoHost: environment.server.DEMO_HOST,
  ...(environment.dingtalk.DINGTALK_CLIENT_ID === undefined
    ? {}
    : { demoInAppClientId: environment.dingtalk.DINGTALK_CLIENT_ID }),
  ...(environment.dingtalk.DINGTALK_CORP_ID === undefined
    ? {}
    : { demoInAppCorpId: environment.dingtalk.DINGTALK_CORP_ID }),
  demoWebUrl: environment.server.DEMO_WEB_URL,
  dingtalk,
  mcpTokens: createMcpTokenService({
    hashSecret: environment.server.MCP_TOKEN_HASH_SECRET,
    repository: createMcpTokenRepository(prisma),
  }),
  projects,
  projectManagement: projects,
  projectDeletion,
  rateLimits: {
    authPerMinute: environment.server.AUTH_RATE_LIMIT_PER_MINUTE,
    contentIpPerMinute: environment.server.CONTENT_IP_RATE_LIMIT_PER_MINUTE,
    contentSessionPerMinute: environment.server.CONTENT_SESSION_RATE_LIMIT_PER_MINUTE,
    mcpPerMinute: environment.server.MCP_RATE_LIMIT_PER_MINUTE,
    mcpUploadCompletePerMinute: environment.server.MCP_UPLOAD_COMPLETE_RATE_LIMIT_PER_MINUTE,
    mcpUploadPreparePerMinute: environment.server.MCP_UPLOAD_PREPARE_RATE_LIMIT_PER_MINUTE,
  },
  storage,
  trustProxy: environment.server.TRUSTED_PROXY_IPS ?? false,
  uploads: createUploadService({
    repository: createUploadRepository(prisma, {
      passwordCrypto,
      passwordManagementCrypto,
    }),
  }),
});

app.addHook("onClose", async () => {
  await prisma.$disconnect();
});

try {
  await app.listen({
    host: environment.server.SERVER_HOST,
    port: environment.server.SERVER_PORT,
    listenTextResolver: () => "server listening",
  });
} catch (error) {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "LISTEN_FAILED";
  app.log.error({ code }, "server failed to start");
  process.exitCode = 1;
}

function readAdministratorIds(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
