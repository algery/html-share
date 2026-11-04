import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));

describe("Phase 24 application startup boundary", () => {
  it.each(["server", "worker"])(
    "rejects MySQL before %s business clients or storage start",
    (app) => {
      const result = spawnSync(
        process.execPath,
        ["--env-file=.env.example", "--import", "tsx", `apps/${app}/src/main.ts`],
        {
          cwd: workspace,
          encoding: "utf8",
          env: {
            ...process.env,
            DATABASE_PROVIDER: "mysql",
            DATABASE_URL: "mysql://user:startup-secret@127.0.0.1:1/unreachable",
            DINGTALK_AUTH_MODE: "simulator",
          },
          timeout: 10_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe(
        "DATABASE_PROVIDER: MySQL business repositories are unavailable until Phase 25",
      );
      expect(result.stdout).toBe("");
      expect(`${result.stderr}${result.stdout}`).not.toContain("startup-secret");
      expect(`${result.stderr}${result.stdout}`).not.toContain("mysql://");
    },
  );
});
