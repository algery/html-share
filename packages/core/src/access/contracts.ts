import type { PublishedDemoFile } from "../project/project-reader.js";

export interface PasswordAccessPath {
  projectKey: string;
  relativePath: string;
}

// Internal policy data. Never serialize this object into an HTTP response.
export interface PasswordAccessTarget {
  projectId: string;
  tenantId: string;
  projectKey: string;
  accessMode: "organization" | "password";
  passwordVersion: number;
  passwordHash: string | null;
}

export interface AuthorizedPasswordFile {
  file: PublishedDemoFile;
  principal: string;
}

export interface PasswordAccessRepository {
  findTarget(input: PasswordAccessPath): Promise<PasswordAccessTarget | null>;
  createGrant(input: {
    target: PasswordAccessTarget;
    relativePath: string;
    grantHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<boolean>;
  authorizeFile(
    input: PasswordAccessPath & {
      tenantId: string | null;
      grantHash: string | null;
      now: Date;
    },
  ): Promise<AuthorizedPasswordFile | null>;
}

export interface PasswordAccessService {
  getTarget(input: PasswordAccessPath): Promise<PasswordAccessTarget | null>;
  verifyPassword(input: PasswordAccessPath & { password: string }): Promise<{
    token: string;
    expiresAt: Date;
    projectId: string;
    projectKey: string;
  } | null>;
  authorize(
    input: PasswordAccessPath & {
      tenantId?: string;
      token?: string;
    },
  ): Promise<AuthorizedPasswordFile | null>;
}
