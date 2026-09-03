import { z } from "zod";

type Environment = Record<string, string | undefined>;

const port = z.coerce.number().int().min(1).max(65_535);
const dnsHostname = z
  .string()
  .trim()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );
const bindHost = z.union([dnsHostname, z.ipv4(), z.ipv6()]);
const httpUrl = z.url({ protocol: /^https?$/ });
const nonEmpty = z.string().trim().min(1);
const optionalNonEmpty = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const infrastructureEnvironment = {
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  OBJECT_STORAGE_ACCESS_KEY_ID: nonEmpty,
  OBJECT_STORAGE_ACCESS_KEY_SECRET: nonEmpty,
  OBJECT_STORAGE_BUCKET: nonEmpty,
  OBJECT_STORAGE_ENDPOINT: httpUrl,
  OBJECT_STORAGE_PROVIDER: z.enum(["minio", "oss"]),
  OBJECT_STORAGE_PUBLIC_ENDPOINT: httpUrl.optional(),
  OBJECT_STORAGE_REGION: nonEmpty,
} as const;

const webSchema = z.object({
  NEXT_PUBLIC_API_URL: httpUrl,
  NEXT_PUBLIC_APP_URL: httpUrl,
  NEXT_PUBLIC_DEMO_URL: httpUrl,
});

const serverSchema = z.object({
  APP_AUTH_URL: httpUrl,
  APP_HOST: dnsHostname,
  APP_WEB_URL: httpUrl,
  AUTH_STATE_SECRET: z.string().min(32),
  MCP_TOKEN_HASH_SECRET: z.string().min(32),
  ...infrastructureEnvironment,
  DEMO_HOST: dnsHostname,
  DEMO_AUTH_URL: httpUrl,
  DEMO_WEB_URL: httpUrl,
  SERVER_HOST: bindHost,
  SERVER_PORT: port,
});

const workerSchema = z.object({
  ...infrastructureEnvironment,
  WORKER_HOST: bindHost,
  WORKER_PORT: port,
});

const dingTalkSchema = z.discriminatedUnion("DINGTALK_AUTH_MODE", [
  z.object({
    DINGTALK_API_BASE_URL: httpUrl.optional(),
    DINGTALK_APP_ID: optionalNonEmpty,
    DINGTALK_AUTH_MODE: z.literal("simulator"),
    DINGTALK_CLIENT_ID: optionalNonEmpty,
    DINGTALK_CORP_ID: optionalNonEmpty,
    DINGTALK_CLIENT_SECRET: optionalNonEmpty,
    DINGTALK_EXTERNAL_AUTHORIZE_URL: httpUrl.optional(),
  }),
  z.object({
    DINGTALK_API_BASE_URL: httpUrl,
    DINGTALK_APP_ID: z.string().trim().min(1),
    DINGTALK_AUTH_MODE: z.literal("live"),
    DINGTALK_CLIENT_ID: z.string().trim().min(1),
    DINGTALK_CORP_ID: z.string().trim().min(1),
    DINGTALK_CLIENT_SECRET: z.string().trim().min(1),
    DINGTALK_EXTERNAL_AUTHORIZE_URL: httpUrl,
  }),
]);

export class EnvironmentValidationError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    const uniqueVariables = [...new Set(variables)].sort();
    super(`Invalid environment variables: ${uniqueVariables.join(", ")}`);
    this.name = "EnvironmentValidationError";
    this.variables = uniqueVariables;
  }
}

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
  return parseEnvironment(serverSchema, environment);
}

export function readWorkerEnv(environment: Environment) {
  return parseEnvironment(workerSchema, environment);
}

export function readDingTalkEnv(environment: Environment) {
  return parseEnvironment(dingTalkSchema, environment);
}
