export {
  AuthenticationError,
  createAuthSessionService,
  type AuthSessionService,
  type AccessSessionRecord,
} from "./auth/session-service.js";
export { InMemoryAuthRepository } from "./auth/in-memory-auth-repository.js";
export type {
  AuthRepository,
  AuthStateRecord,
  DingTalkIdentity,
  PlatformUserIdentity,
  SessionAudience,
} from "./auth/contracts.js";
export type {
  ManagedDemoProject,
  OwnedProjects,
  ProjectManagementReader,
  ProjectReader,
  PublishedDemoFile,
} from "./project/project-reader.js";
export {
  createProjectDeletionService,
  ProjectDeletionError,
  type AdminProjectSummary,
  type ProjectDeletionOutcome,
  type ProjectDeletionRepository,
  type ProjectDeletionService,
} from "./project/delete-service.js";
export {
  createPasswordManagementService,
  PasswordManagementError,
  projectPasswordContext,
  type ManagedProjectAccess,
  type PasswordManagementAction,
  type PasswordManagementRepository,
  type PasswordManagementService,
  type ProjectPasswordStatus,
} from "./project/password-management-service.js";
export type {
  AuthenticatedMcpToken,
  McpTokenRepository,
  McpTokenStatus,
  McpTokenSummary,
} from "./token/contracts.js";
export { InMemoryMcpTokenRepository } from "./token/in-memory-token-repository.js";
export {
  createMcpTokenService,
  McpTokenError,
  toTokenResponse,
  type McpTokenService,
} from "./token/token-service.js";
export {
  MAX_DEMO_FILE_BYTES,
  MAX_DEMO_FILES,
  MAX_DEMO_TOTAL_BYTES,
  MAX_DEMOS_PER_USER,
  MAX_STORAGE_BYTES_PER_USER,
  UPLOAD_IDEMPOTENCY_TTL_MS,
  UPLOAD_URL_TTL_MS,
  type FileManifestItem,
  type PrepareDemoUploadInput,
  type PreparedUpload,
  type PreparedUploadFile,
  type UploadAction,
  type DemoAccessMode,
  UploadError,
  type UploadErrorCode,
  type UploadRepository,
  type UploadTaskStatus,
  type UploadTaskSummary,
  type ValidatedPrepareDemoUploadInput,
} from "./upload/contracts.js";
export { InMemoryUploadRepository } from "./upload/in-memory-upload-repository.js";
export {
  digestManifest,
  mimeForPath,
  normalizeRelativePath,
  validateManifest,
} from "./upload/manifest-validator.js";
export { createUploadService, type UploadService } from "./upload/upload-service.js";
export { createPasswordCrypto } from "./access/password-crypto.js";

export { createPasswordAccessService } from "./access/password-access-service.js";
export type {
  PasswordAccessRepository,
  PasswordAccessTarget,
  PasswordAccessService,
  PasswordAccessPath,
  AuthorizedPasswordFile,
} from "./access/contracts.js";

export { resolveHomepage, homepageLink } from "./project/homepage.js";
