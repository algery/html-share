import {
  AuthenticationError,
  AccountLinkError,
  McpTokenError,
  PasswordManagementError,
  ProjectDeletionError,
  UploadError,
  SquareError,
} from "@html-share/core";

import { createSquareCoverRepository } from "./square-cover-repository.js";
import { createSquareRepository } from "./square-repository.js";
import { createMysqlSquareRepository } from "./mysql/square-repository.js";
import { createAuthRepository } from "./auth-repository.js";
import { createMcpTokenRepository } from "./mcp-token-repository.js";
import { createProjectReader } from "./project-reader.js";
import { createPasswordAccessRepository } from "./password-access-repository.js";
import { createPasswordManagementRepository } from "./password-management-repository.js";
import { createUploadRepository } from "./upload-repository.js";
import { createProjectDeletionRepository } from "./project-deletion-repository.js";
import { createCleanupRepository } from "./cleanup-repository.js";
import { createPasswordCleanupRepository } from "./password-cleanup-repository.js";
import { createOrphanSweepRepository } from "./orphan-sweep-repository.js";
import { createMysqlAuthRepository } from "./mysql/auth-repository.js";
import { createMysqlMcpTokenRepository } from "./mysql/mcp-token-repository.js";
import { createMysqlProjectReader } from "./mysql/project-reader.js";
import { createMysqlPasswordAccessRepository } from "./mysql/password-access-repository.js";
import { createMysqlPasswordManagementRepository } from "./mysql/password-management-repository.js";
import { createMysqlUploadRepository } from "./mysql/upload-repository.js";
import { createMysqlProjectDeletionRepository } from "./mysql/project-deletion-repository.js";
import { createMysqlCleanupRepository } from "./mysql/cleanup-repository.js";
import { createMysqlPasswordCleanupRepository } from "./mysql/password-cleanup-repository.js";
import { createMysqlOrphanSweepRepository } from "./mysql/orphan-sweep-repository.js";
import { DatabaseOperationError } from "./database-errors.js";
import type { DatabaseConnection } from "./database-client.js";

export interface DatabaseRepositories {
  auth: ReturnType<typeof createAuthRepository>;
  square: ReturnType<typeof createSquareRepository>;
  squareCovers: ReturnType<typeof createSquareCoverRepository>;
  mcpTokens: ReturnType<typeof createMcpTokenRepository>;
  projects: ReturnType<typeof createProjectReader>;
  passwordAccess: ReturnType<typeof createPasswordAccessRepository>;
  passwordManagement: ReturnType<typeof createPasswordManagementRepository>;
  uploads: ReturnType<typeof createUploadRepository>;
  deletion: ReturnType<typeof createProjectDeletionRepository>;
  cleanup: ReturnType<typeof createCleanupRepository>;
  passwordCleanup: ReturnType<typeof createPasswordCleanupRepository>;
  orphanSweep: ReturnType<typeof createOrphanSweepRepository>;
}

function protectedRepository<T extends object>(repository: T): T {
  return new Proxy(repository, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...arguments_: unknown[]): Promise<unknown> => {
        try {
          return await Reflect.apply(value, target, arguments_);
        } catch (error) {
          if (
            error instanceof AuthenticationError ||
            error instanceof AccountLinkError ||
            error instanceof McpTokenError ||
            error instanceof PasswordManagementError ||
            error instanceof ProjectDeletionError ||
            error instanceof UploadError ||
            error instanceof SquareError ||
            error instanceof DatabaseOperationError
          )
            throw error;
          throw new DatabaseOperationError("repository");
        }
      };
    },
  });
}

export function createDatabaseRepositories(
  connection: DatabaseConnection,
  options: NonNullable<Parameters<typeof createUploadRepository>[1]> = {},
): DatabaseRepositories {
  if (connection.provider === "mysql") {
    const client = connection.client;
    return {
      auth: protectedRepository(createMysqlAuthRepository(client)),
      square: protectedRepository(createMysqlSquareRepository(client)),
      squareCovers: protectedRepository(createSquareCoverRepository(connection)),
      mcpTokens: protectedRepository(createMysqlMcpTokenRepository(client)),
      projects: protectedRepository(createMysqlProjectReader(client)),
      passwordAccess: protectedRepository(createMysqlPasswordAccessRepository(client)),
      passwordManagement: protectedRepository(createMysqlPasswordManagementRepository(client)),
      uploads: protectedRepository(createMysqlUploadRepository(client, options)),
      deletion: protectedRepository(createMysqlProjectDeletionRepository(client)),
      cleanup: protectedRepository(createMysqlCleanupRepository(client)),
      passwordCleanup: protectedRepository(createMysqlPasswordCleanupRepository(client)),
      orphanSweep: protectedRepository(createMysqlOrphanSweepRepository(client)),
    };
  }
  const client = connection.client;
  return {
    auth: protectedRepository(createAuthRepository(client)),
    square: protectedRepository(createSquareRepository(client)),
    squareCovers: protectedRepository(createSquareCoverRepository(connection)),
    mcpTokens: protectedRepository(createMcpTokenRepository(client)),
    projects: protectedRepository(createProjectReader(client)),
    passwordAccess: protectedRepository(createPasswordAccessRepository(client)),
    passwordManagement: protectedRepository(createPasswordManagementRepository(client)),
    uploads: protectedRepository(createUploadRepository(client, options)),
    deletion: protectedRepository(createProjectDeletionRepository(client)),
    cleanup: protectedRepository(createCleanupRepository(client)),
    passwordCleanup: protectedRepository(createPasswordCleanupRepository(client)),
    orphanSweep: protectedRepository(createOrphanSweepRepository(client)),
  };
}
