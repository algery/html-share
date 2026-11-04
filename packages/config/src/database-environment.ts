import { URL } from "node:url";

export type DatabaseProvider = "postgresql" | "mysql";
export interface DatabaseEnvironment {
  DATABASE_PROVIDER: DatabaseProvider;
  DATABASE_URL: string;
}

export class EnvironmentValidationError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    const uniqueVariables = [...new Set(variables)].sort();
    super(`Invalid environment variables: ${uniqueVariables.join(", ")}`);
    this.name = "EnvironmentValidationError";
    this.variables = uniqueVariables;
  }
}

// Keep this module free of workspace dependencies so Node-based migration and
// deployment tools can import the TypeScript source before packages are built.
export function readDatabaseEnv(
  environment: Record<string, string | undefined>,
): DatabaseEnvironment {
  const provider = environment["DATABASE_PROVIDER"] ?? "postgresql";
  const databaseUrl = environment["DATABASE_URL"];
  const invalidVariables: string[] = [];
  if (provider !== "postgresql" && provider !== "mysql") {
    invalidVariables.push("DATABASE_PROVIDER");
  }

  let url: URL | undefined;
  try {
    if (databaseUrl === undefined || databaseUrl.trim() === "") {
      throw new Error("Missing URL");
    }
    url = new URL(databaseUrl);
  } catch {
    invalidVariables.push("DATABASE_URL");
  }
  if (url !== undefined) {
    const allowedProtocol =
      provider === "postgresql"
        ? url.protocol === "postgresql:" || url.protocol === "postgres:"
        : provider === "mysql"
          ? url.protocol === "mysql:"
          : true;
    const hasHost =
      url.hostname !== "" ||
      (provider === "postgresql" && url.searchParams.get("host")?.startsWith("/"));
    if (
      !allowedProtocol ||
      !hasHost ||
      !/^(?:postgres(?:ql)?|mysql):\/\//i.test(databaseUrl ?? "")
    ) {
      invalidVariables.push("DATABASE_URL");
    }
  }
  if (invalidVariables.length > 0) throw new EnvironmentValidationError(invalidVariables);
  // These guards narrow the validated values without asserting away invalid input.
  if ((provider !== "postgresql" && provider !== "mysql") || databaseUrl === undefined) {
    throw new EnvironmentValidationError(["DATABASE_PROVIDER", "DATABASE_URL"]);
  }
  return { DATABASE_PROVIDER: provider, DATABASE_URL: databaseUrl };
}
