import type { DemoAccessMode } from "../upload/contracts.js";
import type { createPasswordCrypto } from "../access/password-crypto.js";

export type PasswordManagementAction = "disable" | "enable" | "regenerate";
export type ProjectPasswordStatus = "available" | "disabled" | "unavailable";

export interface ManagedProjectAccess {
  accessMode: DemoAccessMode;
  accessPassword?: string;
  passwordStatus: ProjectPasswordStatus;
}

export interface PasswordManagementProject {
  accessMode: DemoAccessMode;
  encryptedPassword: string | null;
  id: string;
  ownerUserId: string;
  passwordVersion: number;
  projectKey: string;
}

export interface PasswordManagementRepository {
  applyOwnedChange(input: {
    action: PasswordManagementAction;
    encryptedPassword: string | null;
    expectedAccessMode: DemoAccessMode;
    expectedPasswordVersion: number;
    now: Date;
    ownerUserId: string;
    passwordHash: string | null;
    passwordVersion: number;
    projectKey: string;
    requestIp: string;
    traceId: string;
  }): Promise<"conflict" | "not_found" | "updated" | "upload_conflict">;
  findOwnedActive(input: {
    ownerUserId: string;
    projectKey: string;
  }): Promise<PasswordManagementProject | null>;
}

export class PasswordManagementError extends Error {
  constructor(readonly code: "DECRYPTION_FAILED" | "INVALID_ACTION") {
    super(code);
  }
}

export function projectPasswordContext(project: {
  id: string;
  ownerUserId: string;
  passwordVersion: number;
}) {
  return JSON.stringify([project.id, project.ownerUserId, project.passwordVersion]);
}

export function createPasswordManagementService(options: {
  now?: () => Date;
  passwordCrypto: ReturnType<typeof createPasswordCrypto>;
  repository: PasswordManagementRepository;
}) {
  const now = options.now ?? (() => new Date());

  async function readOwnedProjectAccess(input: { ownerUserId: string; projectKey: string }) {
    const project = await options.repository.findOwnedActive(input);
    return project === null ? null : readAccess(project, options.passwordCrypto);
  }

  return {
    readOwnedProjectAccess,

    async changeOwnedProjectAccess(input: {
      action: PasswordManagementAction;
      ownerUserId: string;
      projectKey: string;
      requestIp: string;
      traceId: string;
    }): Promise<
      | { outcome: "conflict" | "not_found" | "upload_conflict" }
      | { access: ManagedProjectAccess; outcome: "updated" }
    > {
      const project = await options.repository.findOwnedActive(input);
      if (project === null) return { outcome: "not_found" };
      if (input.action === "enable" && project.accessMode === "password") {
        throw new PasswordManagementError("INVALID_ACTION");
      }
      if (input.action === "disable" && project.accessMode === "organization") {
        return { access: readAccess(project, options.passwordCrypto), outcome: "updated" };
      }
      if (input.action === "regenerate" && project.accessMode !== "password") {
        throw new PasswordManagementError("INVALID_ACTION");
      }

      const passwordVersion = project.passwordVersion + 1;
      const candidate = input.action === "disable" ? null : await options.passwordCrypto.generate();
      const encryptedPassword =
        candidate === null
          ? null
          : options.passwordCrypto.encrypt(
              candidate.password,
              projectPasswordContext({ ...project, passwordVersion }),
            );
      const outcome = await options.repository.applyOwnedChange({
        action: input.action,
        encryptedPassword,
        expectedAccessMode: project.accessMode,
        expectedPasswordVersion: project.passwordVersion,
        now: now(),
        ownerUserId: input.ownerUserId,
        passwordHash: candidate?.hash ?? null,
        passwordVersion,
        projectKey: input.projectKey,
        requestIp: input.requestIp,
        traceId: input.traceId,
      });
      if (outcome !== "updated") return { outcome };
      return {
        access:
          candidate === null
            ? { accessMode: "organization", passwordStatus: "disabled" }
            : {
                accessMode: "password",
                accessPassword: candidate.password,
                passwordStatus: "available",
              },
        outcome,
      };
    },
  };
}

function readAccess(
  project: PasswordManagementProject,
  crypto: ReturnType<typeof createPasswordCrypto>,
): ManagedProjectAccess {
  if (project.accessMode === "organization") {
    return { accessMode: "organization", passwordStatus: "disabled" };
  }
  if (project.encryptedPassword === null) {
    return { accessMode: "password", passwordStatus: "unavailable" };
  }
  try {
    return {
      accessMode: "password",
      accessPassword: crypto.decrypt(project.encryptedPassword, projectPasswordContext(project)),
      passwordStatus: "available",
    };
  } catch {
    throw new PasswordManagementError("DECRYPTION_FAILED");
  }
}

export type PasswordManagementService = ReturnType<typeof createPasswordManagementService>;
