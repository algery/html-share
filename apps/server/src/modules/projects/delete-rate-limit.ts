const WINDOW_MS = 60 * 1000;

export function createDeletionRateLimiter(options?: { now?: () => Date }) {
  const now = options?.now ?? (() => new Date());
  const entries = new Map<string, { count: number; startedAt: Date }>();

  return {
    consume(input: { key: string; maximum: number }) {
      const current = now();
      const record = entries.get(input.key);
      const active =
        record !== undefined && current.getTime() - record.startedAt.getTime() < WINDOW_MS
          ? record
          : { count: 0, startedAt: current };
      entries.set(input.key, active);
      if (active.count >= input.maximum) {
        return {
          allowed: false as const,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((WINDOW_MS - (current.getTime() - active.startedAt.getTime())) / 1000),
          ),
        };
      }
      active.count += 1;
      return { allowed: true as const };
    },
  };
}

export type DeletionRateLimiter = ReturnType<typeof createDeletionRateLimiter>;
