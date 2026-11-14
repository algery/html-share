import { createFeishuClient } from "./modules/auth/feishu-client.js";
import {
  EnvironmentValidationError,
  readDingTalkEnv,
  readServerEnv,
  readFeishuEnv,
} from "@html-share/config";
import {
  createSquareService,
  MAX_DEMOS_PER_USER,
  createAuthSessionService,
  createMcpTokenService,
  createProjectDeletionService,
  createUploadService,
  createPasswordCrypto,
  createPasswordAccessService,
  createPasswordManagementService,
} from "@html-share/core";
import { invalidateDatabaseDeploymentReceipt, openDatabaseRepositories } from "@html-share/db";
import { createLiveDingTalkClient, createSimulatorDingTalkClient } from "@html-share/dingtalk";
import { createObjectStore } from "@html-share/storage";

import { buildServerApp } from "./app.js";
import { buildDirectoryService } from "./app-directory.js";

function loadEnvironment() {
  try {
    return {
      dingtalk: readDingTalkEnv(process.env),
      server: readServerEnv(process.env),
      feishu: readFeishuEnv(process.env),
    };
  } catch (error) {
    const message =
      error instanceof EnvironmentValidationError ? error.message : "Invalid environment variables";
    console.error(message);
    process.exit(1);
  }
}

if (process.env["DATABASE_DEPLOYMENT_TARGET_FILE"] !== undefined) {
  await invalidateDatabaseDeploymentReceipt({
    targetFile: process.env["DATABASE_DEPLOYMENT_TARGET_FILE"],
    role: "server",
  }).catch(() => {
    console.error("Database deployment approval failed; check shared target directory permissions");
    process.exit(1);
  });
}
const environment = loadEnvironment();
if (environment.feishu.FEISHU_ENABLED && !environment.dingtalk.DINGTALK_APP_ID) {
  console.error("Feishu login requires the existing DINGTALK_APP_ID organization mapping");
  process.exit(1);
}
const maxDemosPerUser = environment.server.MAX_DEMOS_PER_USER ?? MAX_DEMOS_PER_USER;
const passwordCrypto = createPasswordCrypto(environment.server.PASSWORD_RESULT_ENCRYPTION_KEY);
const passwordManagementCrypto = createPasswordCrypto(
  environment.server.PASSWORD_MANAGEMENT_ENCRYPTION_KEY,
);
const repositories = await openDatabaseRepositories(
  environment.server,
  {
    passwordCrypto,
    passwordManagementCrypto,
    maxDemosPerUser,
  },
  environment.server.DATABASE_DEPLOYMENT_TARGET_FILE === undefined
    ? undefined
    : {
        targetFile: environment.server.DATABASE_DEPLOYMENT_TARGET_FILE,
        role: "server",
      },
).catch(() => {
  console.error(
    "Database startup failed; check DATABASE_PROVIDER/DATABASE_URL and migrations/deployment approval",
  );
  process.exit(1);
});
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
const projects = repositories.projects;
const directory = buildDirectoryService(environment.dingtalk);
const projectDeletion = createProjectDeletionService({
  administratorDingTalkUserIds: readAdministratorIds(environment.server.ADMIN_DINGTALK_USER_IDS),
  repository: repositories.deletion,
});
const passwordManagement = createPasswordManagementService({
  passwordCrypto: passwordManagementCrypto,
  repository: repositories.passwordManagement,
});
const app = buildServerApp({
  readiness: repositories.readiness,
  directory,
  square: createSquareService({
    repository: repositories.square,
    directory,
    demoWebUrl: environment.server.DEMO_WEB_URL,
  }),
  passwordStateSecret: environment.server.AUTH_STATE_SECRET,
  passwordAccess: createPasswordAccessService({
    repository: repositories.passwordAccess,
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
    repository: repositories.auth,
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
  ...(environment.feishu.FEISHU_ENABLED
    ? {
        feishu: {
          client: createFeishuClient({
            appId: environment.feishu.FEISHU_APP_ID,
            appSecret: environment.feishu.FEISHU_APP_SECRET,
            tenantKey: environment.feishu.FEISHU_TENANT_KEY,
            tokenApiVersion: environment.feishu.FEISHU_TOKEN_API_VERSION,
          }),
          stateSecret: environment.server.AUTH_STATE_SECRET,
        },
      }
    : {}),
  mcpTokens: createMcpTokenService({
    hashSecret: environment.server.MCP_TOKEN_HASH_SECRET,
    repository: repositories.mcpTokens,
  }),
  projects,
  projectManagement: projects,
  maxDemosPerUser,
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
    repository: repositories.uploads,
  }),
});

app.addHook("onClose", async () => {
  await repositories.close();
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
  await app.close();
}

function readAdministratorIds(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
