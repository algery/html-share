export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface WindowRateLimiter {
  consume(key: string, maximum: number): RateLimitResult;
}

/** A full map fails closed; active attack keys cannot evict another key's budget. */
export function createWindowRateLimiter(options?: {
  now?: () => Date;
  maxKeys?: number;
}): WindowRateLimiter {
  const now = options?.now ?? (() => new Date());
  const maxKeys = options?.maxKeys ?? 10_000;
  const entries = new Map<string, { count: number; expiresAt: number }>();
  return {
    consume(key, maximum): RateLimitResult {
      const current = now().getTime();
      // Fixed windows have ordered expiry, so cleanup only scans expired entries.
      for (const [expiredKey, record] of entries) {
        if (record.expiresAt > current) break;
        entries.delete(expiredKey);
      }
      let record = entries.get(key);
      if (record === undefined) {
        if (entries.size >= maxKeys) return { allowed: false, retryAfterSeconds: 60 };
        record = { count: 0, expiresAt: current + 60_000 };
        entries.set(key, record);
      }
      if (record.count >= maximum)
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((record.expiresAt - current) / 1000)),
        };
      record.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}
