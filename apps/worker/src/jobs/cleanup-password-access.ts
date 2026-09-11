export interface PasswordCleanupRepository {
  cleanupExpired(now: Date): Promise<{ results: number; grants: number }>;
}

export async function runPasswordAccessCleanup(input: {
  repository: PasswordCleanupRepository;
  now?: () => Date;
}) {
  const counts = await input.repository.cleanupExpired((input.now ?? (() => new Date()))());
  return counts.results + counts.grants === 0 ? ("idle" as const) : ("completed" as const);
}
