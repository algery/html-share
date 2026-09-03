import type { AuthenticatedMcpToken, McpTokenService } from "@html-share/core";

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 60;
const UPLOAD_TOOL_RATE_LIMIT_MAX_REQUESTS = 10;

export async function authenticateMcpRequest(input: {
  authorization: string | undefined;
  tokenService: McpTokenService;
}) {
  const token = readBearerToken(input.authorization);
  if (token === null) return null;
  return input.tokenService.authenticate({ token });
}

export function hasTokenQueryParameter(url: string) {
  const parameters = new URL(url, "http://mcp.local").searchParams;
  return parameters.has("token") || parameters.has("access_token");
}

export function createMcpRateLimiter(options?: { now?: () => Date }) {
  const now = options?.now ?? (() => new Date());
  const entries = new Map<string, { count: number; startedAt: Date }>();

  return {
    consume(input: { token: AuthenticatedMcpToken; ip: string }) {
      const current = now();
      const keys = [`token:${input.token.id}`, `user:${input.token.user.id}`, `ip:${input.ip}`];
      const records = keys.map((key) => [key, getRecord(entries, key, current)] as const);
      const limited = records.find(([, record]) => record.count >= RATE_LIMIT_MAX_REQUESTS);
      if (limited !== undefined) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil(
            (RATE_LIMIT_WINDOW_MS - (current.getTime() - limited[1].startedAt.getTime())) / 1000,
          ),
        );
        return { allowed: false as const, retryAfterSeconds };
      }
      for (const [, record] of records) record.count += 1;
      return { allowed: true as const };
    },
  };
}

export function createUploadToolRateLimiter(options?: { now?: () => Date }) {
  const now = options?.now ?? (() => new Date());
  const entries = new Map<string, { count: number; startedAt: Date }>();
  return {
    consumeComplete(uploadId: string) {
      return consume(entries, `complete:${uploadId}`, now(), UPLOAD_TOOL_RATE_LIMIT_MAX_REQUESTS);
    },
    consumePrepare(userId: string) {
      return consume(entries, `prepare:${userId}`, now(), UPLOAD_TOOL_RATE_LIMIT_MAX_REQUESTS);
    },
  };
}

function readBearerToken(authorization: string | undefined) {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization ?? "");
  return match?.[1] ?? null;
}

function getRecord(
  entries: Map<string, { count: number; startedAt: Date }>,
  key: string,
  current: Date,
) {
  const existing = entries.get(key);
  if (
    existing !== undefined &&
    current.getTime() - existing.startedAt.getTime() < RATE_LIMIT_WINDOW_MS
  ) {
    return existing;
  }
  const record = { count: 0, startedAt: current };
  entries.set(key, record);
  return record;
}

function consume(
  entries: Map<string, { count: number; startedAt: Date }>,
  key: string,
  current: Date,
  maximum: number,
) {
  const record = getRecord(entries, key, current);
  if (record.count >= maximum) {
    return {
      allowed: false as const,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((RATE_LIMIT_WINDOW_MS - (current.getTime() - record.startedAt.getTime())) / 1000),
      ),
    };
  }
  record.count += 1;
  return { allowed: true as const };
}
