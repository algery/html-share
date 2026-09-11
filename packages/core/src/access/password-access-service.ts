import { createHash, randomBytes } from "node:crypto";
import type {
  PasswordAccessPath,
  PasswordAccessRepository,
  PasswordAccessService,
} from "./contracts.js";

const GRANT_LIFETIME_MS = 8 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function validPath(input: PasswordAccessPath): boolean {
  return (
    /^[a-z0-9]{5}$/.test(input.projectKey) &&
    input.relativePath.length > 0 &&
    input.relativePath.length <= 1024 &&
    !input.relativePath.includes("\\") &&
    ![...input.relativePath].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    input.relativePath.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function tokenHash(token: string | undefined): string | null {
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== token) return null;
  return createHash("sha256").update(token).digest("hex");
}

export function createPasswordAccessService(dependencies: {
  repository: PasswordAccessRepository;
  passwordCrypto: { verify(password: string, hash: string): Promise<boolean> };
  now?: () => Date;
}): PasswordAccessService {
  const { repository, passwordCrypto } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  return {
    async getTarget(input) {
      return validPath(input) ? repository.findTarget(input) : null;
    },

    async verifyPassword(input) {
      if (!validPath(input) || input.password.length > 256) return null;
      const password = input.password.trim();
      if (!password) return null;
      const target = await repository.findTarget({
        projectKey: input.projectKey,
        relativePath: input.relativePath,
      });
      if (!target || target.accessMode !== "password" || !target.passwordHash) return null;
      // The expensive scrypt computation must complete before opening the grant transaction.
      if (!(await passwordCrypto.verify(password, target.passwordHash))) return null;
      const token = randomBytes(32).toString("base64url");
      const issuedAt = now();
      const expiresAt = new Date(issuedAt.getTime() + GRANT_LIFETIME_MS);
      const accepted = await repository.createGrant({
        target,
        relativePath: input.relativePath,
        grantHash: createHash("sha256").update(token).digest("hex"),
        now: issuedAt,
        expiresAt,
      });
      return accepted
        ? { token, expiresAt, projectId: target.projectId, projectKey: target.projectKey }
        : null;
    },

    async authorize(input) {
      if (!validPath(input)) return null;
      const grantHash = tokenHash(input.token);
      if (!input.tenantId && !grantHash) return null;
      return repository.authorizeFile({
        projectKey: input.projectKey,
        relativePath: input.relativePath,
        tenantId: input.tenantId ?? null,
        grantHash,
        now: now(),
      });
    },
  };
}
