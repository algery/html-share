import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../", import.meta.url));

export function runPrisma(arguments_, environment) {
  const result = spawnSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", ...arguments_],
    {
      cwd: workspace,
      env: { ...process.env, ...environment },
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    const code = `${result.stdout}${result.stderr}`.match(/\bP\d{4}\b/)?.[0];
    throw new Error(
      `Database command failed${code ? ` (${code})` : ""}; check configuration and migration state`,
    );
  }
  // Never forward driver/CLI diagnostics containing connection strings or SQL.
  return result;
}
