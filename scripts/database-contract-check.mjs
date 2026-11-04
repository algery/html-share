import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readContractDatabases } from "../packages/db/dist/testing/database-fixture.js";

let directory;
let configured = false;
try {
  readContractDatabases();
  configured = true;
  const root = fileURLToPath(new URL("../", import.meta.url));
  const files = readdirSync(new URL("./", import.meta.url))
    .filter((name) => /^database-contract-.*\.test\.mjs$/.test(name))
    .map((name) => `scripts/${name}`);
  if (files.length === 0) throw new Error("The database contract matrix has no tests");
  directory = mkdtempSync(join(tmpdir(), "html-share-phase25-contract-"));
  const report = join(directory, "result.json");
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      ...files,
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${report}`,
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, PHASE25_CONTRACT_REQUIRED: "1" },
      timeout: 180_000,
    },
  );
  process.exitCode = result.status ?? 1;
  if (process.exitCode === 0) {
    const summary = JSON.parse(readFileSync(report, "utf8"));
    const assertions = summary.testResults.flatMap((suite) => suite.assertionResults);
    if (
      assertions.length === 0 ||
      assertions.some((test) => test.status !== "passed") ||
      !["postgresql", "mysql"].every((provider) =>
        assertions.some((test) => test.fullName.startsWith(`Phase 25 ${provider}:`)),
      )
    ) {
      throw new Error("Both real database suites must pass without skipped or todo tests");
    }
  }
} catch {
  console.error(
    configured
      ? "Phase 25 contracts require both real providers to pass every test without skips or todo results"
      : "Both PHASE25_POSTGRES_URL and PHASE25_MYSQL_URL must identify isolated local html_share_phase25_* databases",
  );
  process.exitCode = 1;
} finally {
  if (directory) rmSync(directory, { recursive: true, force: true });
}
