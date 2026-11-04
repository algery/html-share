import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const workspace = fileURLToPath(new URL("../", import.meta.url));
export const providers = ["postgresql", "mysql"];

export function isolatedUrl(value, provider, pattern, port) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("An isolated local database URL is required");
  }
  assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Local database required");
  assert(pattern.test(url.pathname.slice(1)), "Explicitly named isolated database required");
  assert(
    provider === "mysql"
      ? url.protocol === "mysql:"
      : ["postgres:", "postgresql:"].includes(url.protocol),
    "Database protocol mismatch",
  );
  if (port) assert(url.port === port, "Isolated database port mismatch");
  for (const [key, value] of url.searchParams) {
    assert(
      provider === "mysql"
        ? key === "allowPublicKeyRetrieval" && ["true", "false"].includes(value)
        : key === "schema" && value === "public",
      "Isolation forbids database/host/socket/schema overrides",
    );
  }
  assert(!url.hash, "Database URL fragment is unsupported");
  return value;
}

export function matrixConfiguration(env = process.env) {
  assert(env.PHASE10_MINIO_ENDPOINT === "http://127.0.0.1:59000", "Isolated MinIO required");
  return providers.map((provider) => {
    const suffix = provider === "mysql" ? "MYSQL" : "POSTGRES";
    return {
      provider,
      contractUrl: isolatedUrl(
        env[`PHASE25_${suffix}_URL`],
        provider,
        /^html_share_phase25_[a-z0-9_]+$/,
      ),
      databaseUrl: isolatedUrl(
        env[`PHASE26_${suffix}_HTTP_URL`],
        provider,
        /^html_share_phase25_http$/,
        provider === "mysql" ? "53319" : "55439",
      ),
    };
  });
}

// Capture child output: driver diagnostics, browser failures and assertion text may contain secrets.
export function runCaptured(script, additions = {}, args = [], timeout = 300_000) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: workspace,
    env: { ...process.env, ...additions },
    encoding: "utf8",
    timeout,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const details = {
      script,
      locations: [...output.matchAll(/database-browser[-a-z]*\.mjs:\d+:\d+/g)].map(
        (match) => match[0],
      ),
    };
    const events = output.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const pages = events.filter((event) => event?.stage === "browser-page-errors");
    const errors = pages
      .flatMap((event) => (Array.isArray(event.errors) ? event.errors : []))
      .filter((message) => typeof message === "string");
    // Emit only bounded categories/codes; original browser/driver output stays private.
    console.error(
      JSON.stringify({
        ...details,
        stage: "matrix-child-failure",
        browserPageErrors: errors.length,
        reactCodes: errors.flatMap((message) =>
          [...message.matchAll(/(?:Minified React error #|react\.dev\/errors\/)([0-9]+)/g)].map(
            (match) => match[1],
          ),
        ),
        loadFailure: errors.some((message) => /Load failed|Failed to fetch/i.test(message)),
      }),
    );
  }
  assert(!result.error && result.status === 0, `${script} failed; captured output withheld`);
  return result.stdout;
}

export function smokeReport(output, status, minimumAssertions = 1) {
  const reports = output.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const report = reports.find(
    (value) => value !== null && typeof value === "object" && value.status === status,
  );
  assert(
    report && (minimumAssertions === 0 || report.assertions >= minimumAssertions),
    `Required ${status} evidence missing`,
  );
  return report;
}

export function requirePassedAssertions(summary) {
  const results = summary.testResults.flatMap((suite) => suite.assertionResults);
  assert(
    results.length > 0 && results.every((item) => item.status === "passed"),
    "All required assertions must pass without skips or todo",
  );
  return results.length;
}
