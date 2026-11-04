import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

import { readDatabaseEnv } from "../packages/config/src/database-environment.ts";

const ROLES = ["server", "worker", "migration"];

/** Explicit per-role files never inherit the shell's database credentials/provider. */
export async function readDeploymentDatabases(arguments_, environment = process.env) {
  const files = new Map();
  for (const argument of arguments_) {
    const match = /^--(server|worker|migration)-env=(.+)$/.exec(argument);
    if (!match || files.has(match[1]))
      throw new Error("Invalid database deployment preflight arguments");
    files.set(match[1], match[2]);
  }
  const result = [];
  for (const role of ROLES) {
    let source = environment;
    if (files.has(role)) {
      try {
        source = parseEnv(await readFile(files.get(role), "utf8"));
      } catch {
        throw new Error(`Cannot read ${role} database environment file`);
      }
    }
    try {
      result.push({ role, environment: readDatabaseEnv(source) });
    } catch {
      throw new Error(
        `Invalid ${role} database configuration; check DATABASE_PROVIDER/DATABASE_URL`,
      );
    }
  }
  return result;
}
