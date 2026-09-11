import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/.next/**", "**/dist/**", "**/node_modules/**", "**/out/**"],
    include: [
      "apps/**/*.{test,spec}.{ts,tsx}",
      "packages/**/*.{test,spec}.{ts,tsx}",
      "scripts/**/*.{test,spec}.mjs",
    ],
    passWithNoTests: false,
    // PostgreSQL integration suites exercise global expiry/cleanup scans against
    // one isolated database. Running files concurrently can expire another
    // suite's deliberately blocked task and makes race assertions meaningless.
    fileParallelism: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
