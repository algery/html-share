export interface DirectoryDepartment {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  hasChildren: boolean;
}

export interface DirectoryUser {
  id: string;
  name: string;
  departmentPaths: string[];
}

export interface DirectorySnapshot {
  departments: DirectoryDepartment[];
  users: DirectoryUser[];
  limited: boolean;
}

export interface DirectoryMember {
  userId: string;
  /** Current departments and their complete ancestor chains. */
  departmentIds: string[];
}

export interface DirectoryGateway {
  getSnapshot(input: { tenantId: string }): Promise<DirectorySnapshot>;
  resolveMember(input: { tenantId: string; unionId: string }): Promise<DirectoryMember>;
}

export type DirectoryFailureReason =
  | "disabled"
  | "invalid_response"
  | "identity_unconfirmed"
  | "limit_exceeded"
  | "provider_rejected"
  | "unavailable"
  | "timeout";

export class DirectoryUnavailableError extends Error {
  readonly code = "DIRECTORY_UNAVAILABLE";

  constructor(readonly reason: DirectoryFailureReason = "unavailable") {
    super("DIRECTORY_UNAVAILABLE");
    this.name = "DirectoryUnavailableError";
  }
}
