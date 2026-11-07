import { URL } from "node:url";

import { z } from "zod";

import { EnvironmentValidationError, readDatabaseEnv } from "./database-environment.js";
import { validateObjectStorageEnvironment } from "./object-storage-environment.js";

export { EnvironmentValidationError } from "./database-environment.js";

type Environment = Record<string, string | undefined>;

const port = z.coerce.number().int().min(1).max(65_535);
const dnsHostname = z
  .string()
  .trim()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );
const bindHost = z.union([dnsHostname, z.ipv4(), z.ipv6()]);
const browserHost = z
  .union([dnsHostname, z.literal("::1")])
  .transform((value) => (value === "::1" ? "[::1]" : value));
const httpUrl = z.url({ protocol: /^https?$/ });
const nonEmpty = z.string().trim().min(1);
const rateLimit = z.coerce.number().int().min(1).max(100_000);
const workerConcurrency = z.coerce.number().int().min(1).max(10);
const storageOperationTimeout = z.coerce.number().int().min(100).max(120_000);
const trustedProxyIps = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string()
    .trim()
    .min(1)
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    )
    .optional(),
);
const optionalNonEmpty = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const infrastructureEnvironment = {
  OBJECT_STORAGE_ACCESS_KEY_ID: nonEmpty,
  OBJECT_STORAGE_ACCESS_KEY_SECRET: nonEmpty,
  OBJECT_STORAGE_BUCKET: nonEmpty,
  OBJECT_STORAGE_ENDPOINT: httpUrl,
  OBJECT_STORAGE_PROVIDER: z.enum(["minio", "oss", "r2"]),
  OBJECT_STORAGE_PUBLIC_ENDPOINT: httpUrl.optional(),
  OBJECT_STORAGE_REGION: nonEmpty,
} as const;

const webSchema = z.object({
  NEXT_PUBLIC_API_URL: httpUrl,
  NEXT_PUBLIC_APP_URL: httpUrl,
  NEXT_PUBLIC_DEMO_URL: httpUrl,
});

const serverSchema = z
  .object({
    APP_AUTH_URL: httpUrl,
    APP_HOST: browserHost,
    APP_WEB_URL: httpUrl,
    ADMIN_DINGTALK_USER_IDS: optionalNonEmpty,
    AUTH_STATE_SECRET: z.string().min(32),
    AUTH_RATE_LIMIT_PER_MINUTE: rateLimit.default(30),
    CONTENT_IP_RATE_LIMIT_PER_MINUTE: rateLimit.default(1200),
    CONTENT_SESSION_RATE_LIMIT_PER_MINUTE: rateLimit.default(600),
    MAX_DEMOS_PER_USER: z
      .string()
      .trim()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().positive())
      .optional(),
    MCP_TOKEN_HASH_SECRET: z.string().min(32),
    PASSWORD_MANAGEMENT_ENCRYPTION_KEY: z.string().regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/),
    PASSWORD_RESULT_ENCRYPTION_KEY: z.string().regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/),
    PASSWORD_VERIFY_IP_RATE_LIMIT_PER_MINUTE: rateLimit.default(60),
    PASSWORD_VERIFY_IP_PROJECT_RATE_LIMIT_PER_MINUTE: rateLimit.default(30),
    PASSWORD_VERIFY_PROJECT_RATE_LIMIT_PER_MINUTE: rateLimit.default(120),
    MCP_RATE_LIMIT_PER_MINUTE: rateLimit.default(60),
    MCP_UPLOAD_COMPLETE_RATE_LIMIT_PER_MINUTE: rateLimit.default(10),
    MCP_UPLOAD_PREPARE_RATE_LIMIT_PER_MINUTE: rateLimit.default(10),
    TRUSTED_PROXY_IPS: trustedProxyIps,
    ...infrastructureEnvironment,
    DEMO_HOST: browserHost,
    DEMO_AUTH_URL: httpUrl,
    DEMO_WEB_URL: httpUrl,
    SERVER_HOST: bindHost,
    SERVER_PORT: port,
  })
  .superRefine((value, context) => {
    if (value.PASSWORD_MANAGEMENT_ENCRYPTION_KEY === value.PASSWORD_RESULT_ENCRYPTION_KEY) {
      context.addIssue({
        code: "custom",
        message: "Management and result encryption keys must be independent",
        path: ["PASSWORD_MANAGEMENT_ENCRYPTION_KEY"],
      });
    }
    validateBrowserUrl(context, "APP_AUTH_URL", value.APP_AUTH_URL, value.APP_HOST);
    validateBrowserUrl(context, "APP_WEB_URL", value.APP_WEB_URL, value.APP_HOST);
    validateBrowserUrl(context, "DEMO_AUTH_URL", value.DEMO_AUTH_URL, value.DEMO_HOST);
    validateBrowserUrl(context, "DEMO_WEB_URL", value.DEMO_WEB_URL, value.DEMO_HOST);
    validateObjectStorageEnvironment(context, value);
  });

function validateBrowserUrl(
  context: z.core.$RefinementCtx,
  field: "APP_AUTH_URL" | "APP_WEB_URL" | "DEMO_AUTH_URL" | "DEMO_WEB_URL",
  value: string,
  expectedHostname: string,
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({
      code: "custom",
      message: `${field} must use its configured Host and HTTPS`,
      path: [field],
    });
    return;
  }
  const hostname = normalizeUrlHostname(url.hostname);
  if (
    hostname !== normalizeUrlHostname(expectedHostname) ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalDevelopmentHost(hostname)))
  ) {
    context.addIssue({
      code: "custom",
      message: `${field} must use its configured Host and HTTPS`,
      path: [field],
    });
  }
}

function normalizeUrlHostname(hostname: string) {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isLocalDevelopmentHost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isIpv4Loopback(hostname) ||
    hostname === "::1"
  );
}

function isIpv4Loopback(hostname: string) {
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
    Number(octets[0]) === 127
  );
}

const workerSchema = z
  .object({
    ...infrastructureEnvironment,
    SQUARE_COVER_SOCKET: z
      .string()
      .regex(/^\/[^\0]+$/)
      .max(100)
      .optional(),
    UPLOAD_FINALIZATION_CONCURRENCY: workerConcurrency.default(10),
    UPLOAD_HEAD_OBJECT_TIMEOUT_MS: storageOperationTimeout.default(10_000),
    WORKER_HOST: bindHost,
    WORKER_PORT: port,
  })
  .superRefine((value, context) => validateObjectStorageEnvironment(context, value));

const directoryEnvironment = {
  DINGTALK_DIRECTORY_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  DINGTALK_CONTACT_API_BASE_URL: httpUrl.default("https://oapi.dingtalk.com"),
};

const dingTalkSchema = z.discriminatedUnion("DINGTALK_AUTH_MODE", [
  z.object({
    ...directoryEnvironment,
    DINGTALK_API_BASE_URL: httpUrl.optional(),
    DINGTALK_APP_ID: optionalNonEmpty,
    DINGTALK_AUTH_MODE: z.literal("simulator"),
    DINGTALK_CLIENT_ID: optionalNonEmpty,
    DINGTALK_CORP_ID: optionalNonEmpty,
    DINGTALK_CLIENT_SECRET: optionalNonEmpty,
    DINGTALK_EXTERNAL_AUTHORIZE_URL: httpUrl.optional(),
  }),
  z.object({
    ...directoryEnvironment,
    DINGTALK_API_BASE_URL: httpUrl,
    DINGTALK_APP_ID: z.string().trim().min(1),
    DINGTALK_AUTH_MODE: z.literal("live"),
    DINGTALK_CLIENT_ID: z.string().trim().min(1),
    DINGTALK_CORP_ID: z.string().trim().min(1),
    DINGTALK_CLIENT_SECRET: z.string().trim().min(1),
    DINGTALK_EXTERNAL_AUTHORIZE_URL: httpUrl,
  }),
]);

function parseEnvironment<T>(schema: z.ZodType<T>, environment: Environment): T {
  const result = schema.safeParse(environment);
  if (result.success) {
    return result.data;
  }

  const variables = result.error.issues.map((issue) => {
    const [variable] = issue.path;
    return typeof variable === "string" ? variable : "environment";
  });
  throw new EnvironmentValidationError(variables);
}

export function readWebEnv(environment: Environment) {
  return parseEnvironment(webSchema, environment);
}

export function readServerEnv(environment: Environment) {
  return parseServiceEnvironment(serverSchema, environment);
}

export function readWorkerEnv(environment: Environment) {
  return parseServiceEnvironment(workerSchema, environment);
}

function parseServiceEnvironment<T>(schema: z.ZodType<T>, environment: Environment) {
  const invalidVariables: string[] = [];
  let service: T | undefined;
  let database: ReturnType<typeof readDatabaseEnv> | undefined;
  try {
    service = parseEnvironment(schema, environment);
  } catch (error) {
    if (!(error instanceof EnvironmentValidationError)) throw error;
    invalidVariables.push(...error.variables);
  }
  try {
    database = readDatabaseEnv(environment);
  } catch (error) {
    if (!(error instanceof EnvironmentValidationError)) throw error;
    invalidVariables.push(...error.variables);
  }
  if (service === undefined || database === undefined) {
    throw new EnvironmentValidationError(invalidVariables);
  }
  return { ...service, ...database };
}

export function readDingTalkEnv(environment: Environment) {
  return parseEnvironment(dingTalkSchema, environment);
}
