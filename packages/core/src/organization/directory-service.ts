import {
  DirectoryUnavailableError,
  type DirectoryGateway,
  type DirectoryMember,
  type DirectorySnapshot,
} from "./contracts.js";

export interface DirectoryServiceOptions {
  corpId?: string;
  now?: () => number;
  ttlMs?: number;
}

const MAX_TTL_MS = 300_000;
const MAX_CACHE_ENTRIES = 1_000;

export function createDirectoryService(
  provider: DirectoryGateway,
  options: DirectoryServiceOptions = {},
): DirectoryGateway {
  const now = options.now ?? Date.now;
  const requestedTtlMs = options.ttlMs ?? MAX_TTL_MS;
  if (!Number.isFinite(requestedTtlMs) || requestedTtlMs <= 0)
    throw new Error("Invalid directory cache TTL");
  const ttlMs = Math.min(requestedTtlMs, MAX_TTL_MS);
  const snapshots = createCache<DirectorySnapshot>(now, ttlMs);
  const members = createCache<DirectoryMember>(now, ttlMs);
  const key = (tenantId: string, unionId?: string) => {
    if (!tenantId.trim() || unionId?.trim() === "") {
      throw new DirectoryUnavailableError("identity_unconfirmed");
    }
    return JSON.stringify([tenantId, options.corpId ?? "", unionId ?? null]);
  };
  return {
    getSnapshot(input) {
      return snapshots.get(key(input.tenantId), () => provider.getSnapshot(input));
    },
    resolveMember(input) {
      return members.get(key(input.tenantId, input.unionId), () => provider.resolveMember(input));
    },
  };
}

function createCache<T>(now: () => number, ttlMs: number) {
  const values = new Map<string, { expiresAt: number; value: T }>();
  const pending = new Map<string, Promise<T>>();
  return {
    async get(key: string, fetchValue: () => Promise<T>): Promise<T> {
      const startedAt = now();
      for (const [cachedKey, entry] of values) {
        if (entry.expiresAt <= startedAt) values.delete(cachedKey);
      }
      const cached = values.get(key);
      if (cached) return structuredClone(cached.value);
      let request = pending.get(key);
      if (!request) {
        request = (async () => {
          try {
            const value = await fetchValue();
            const expiresAt = startedAt + ttlMs;
            if (now() >= expiresAt) throw new DirectoryUnavailableError("timeout");
            if (values.size >= MAX_CACHE_ENTRIES) {
              const oldest = values.keys().next().value;
              if (oldest !== undefined) values.delete(oldest);
            }
            values.set(key, { expiresAt, value: structuredClone(value) });
            return value;
          } catch (error) {
            if (error instanceof DirectoryUnavailableError) throw error;
            throw new DirectoryUnavailableError();
          }
        })();
        pending.set(key, request);
        void request.finally(() => pending.delete(key)).catch(() => undefined);
      }
      return structuredClone(await request);
    },
  };
}
