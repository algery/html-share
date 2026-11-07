export { createAuthRepository, createPrismaClient } from "./auth-repository.js";
export { createMcpTokenRepository } from "./mcp-token-repository.js";
export { createProjectReader } from "./project-reader.js";
export { createProjectDeletionRepository } from "./project-deletion-repository.js";
export { createPasswordManagementRepository } from "./password-management-repository.js";
export {
  createCleanupRepository,
  type CleanupBacklog,
  type ClaimedCleanupJob,
} from "./cleanup-repository.js";
export { createUploadRepository, type ProcessingUpload } from "./upload-repository.js";
export { createOrphanSweepRepository, type ClaimedObjectSweep } from "./orphan-sweep-repository.js";

export { createPasswordCleanupRepository } from "./password-cleanup-repository.js";

export { createPasswordAccessRepository } from "./password-access-repository.js";
export { createDatabaseClient, type DatabaseConnection } from "./database-client.js";
export {
  checkDatabaseReadiness,
  assertSameDatabaseDeployment,
  DatabaseReadinessError,
  type DatabaseDeploymentIdentity,
} from "./database-readiness.js";
export { readRequiredDatabaseMigrations, type DatabaseMigration } from "./database-migrations.js";
export { createDatabaseRepositories, type DatabaseRepositories } from "./database-repositories.js";
export { openDatabaseRepositories } from "./database-startup.js";

export {
  joinDatabaseDeployment,
  invalidateDatabaseDeploymentReceipt,
  writeDatabaseDeploymentTarget,
  type DatabaseDeploymentBarrier,
} from "./database-deployment-barrier.js";

export { createSquareRepository } from "./square-repository.js";
export { createMysqlSquareRepository } from "./mysql/square-repository.js";
