import { describe, expect, it, vi } from "vitest";
import {
  isolatedUrl,
  matrixConfiguration,
  requirePassedAssertions,
  smokeReport,
} from "./database-compatibility-support.mjs";
import RequiredBrowserReporter from "./database-browser-reporter.mjs";
import { finalizeCapacityBatch } from "./database-capacity-publication.mjs";
import { observeTransactions, percentile } from "./database-capacity-observer.mjs";

const env = {
  PHASE10_MINIO_ENDPOINT: "http://127.0.0.1:59000",
  PHASE25_POSTGRES_URL: "postgresql://fixture:fixture@127.0.0.1:55439/html_share_phase25_pg",
  PHASE25_MYSQL_URL:
    "mysql://fixture:fixture@127.0.0.1:53319/html_share_phase25_mysql?allowPublicKeyRetrieval=true",
  PHASE26_POSTGRES_HTTP_URL: "postgresql://fixture:fixture@127.0.0.1:55439/html_share_phase25_http",
  PHASE26_MYSQL_HTTP_URL:
    "mysql://fixture:fixture@127.0.0.1:53319/html_share_phase25_http?allowPublicKeyRetrieval=true",
};
describe("mandatory compatibility matrix isolation and evidence", () => {
  it("requires both real provider configurations and isolated storage", () => {
    expect(matrixConfiguration(env).map((value) => value.provider)).toEqual([
      "postgresql",
      "mysql",
    ]);
    for (const key of Object.keys(env))
      expect(() => matrixConfiguration({ ...env, [key]: undefined })).toThrow();
  });
  for (const replacement of [
    "mysql://fixture:fixture@remote.example:53319/html_share_phase25_http",
    "mysql://fixture:fixture@127.0.0.1:3306/html_share_phase25_http",
    "mysql://fixture:fixture@127.0.0.1:53319/business",
    "postgresql://fixture:fixture@127.0.0.1:53319/html_share_phase25_http",
    "mysql://fixture:fixture@127.0.0.1:53319/html_share_phase25_http?socketPath=/tmp/mysql.sock",
    "mysql://fixture:fixture@127.0.0.1:53319/html_share_phase25_http?host=remote.example",
  ])
    it("rejects unsafe or mismatched HTTP target before any connection", () => {
      expect(() => matrixConfiguration({ ...env, PHASE26_MYSQL_HTTP_URL: replacement })).toThrow();
    });
  it("rejects custom PostgreSQL schema overrides and production migration targets", () => {
    expect(() =>
      isolatedUrl(
        `${env.PHASE26_POSTGRES_HTTP_URL}?schema=business`,
        "postgresql",
        /^html_share_phase25_http$/,
      ),
    ).toThrow();
    expect(() =>
      isolatedUrl(
        "postgresql://fixture@localhost/business",
        "postgresql",
        /^html_share_phase26_empty$/,
      ),
    ).toThrow();
  });
  for (const status of ["skipped", "pending", "todo", "failed"])
    it(`rejects ${status} required test evidence`, () => {
      expect(() =>
        requirePassedAssertions({ testResults: [{ assertionResults: [{ status }] }] }),
      ).toThrow();
    });
  it("accepts only nonempty entirely passed suites", () => {
    expect(
      requirePassedAssertions({ testResults: [{ assertionResults: [{ status: "passed" }] }] }),
    ).toBe(1);
    expect(() => requirePassedAssertions({ testResults: [] })).toThrow();
    expect(() => smokeReport('{"status":"done","assertions":0}', "done")).toThrow();
    expect(smokeReport('diagnostic\n{"status":"done","assertions":2}', "done", 2).assertions).toBe(
      2,
    );
  });
  it("reports browser status without retaining failure text, bodies or credentials", () => {
    const captured = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = new RequiredBrowserReporter();
    reporter.onBegin(undefined, {
      allTests: () => [
        {
          title: "required",
          outcome: () => "unexpected",
          expectedStatus: "passed",
          results: [{ status: "failed", error: { message: "fixture-secret" } }],
        },
      ],
    });
    reporter.onEnd({ status: "failed" });
    const output = captured.mock.calls[0][0];
    expect(output).not.toContain("fixture-secret");
    expect(JSON.parse(output).stats).toEqual({ expected: 0, skipped: 0, unexpected: 1, flaky: 0 });
  });
  it("settles all concurrent finalizers before reporting a failed worker", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    let release;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    let settled = false;
    const harness = {
      tenantId: "fixture",
      workerReadiness: vi.fn().mockResolvedValue(undefined),
      prisma: {
        uploadTask: {
          findMany: async () => [{ id: "fixture", status: "FAILED", failureCode: "fixture" }],
        },
      },
      async finalize() {
        calls++;
        if (calls === 1) return "failed";
        await barrier;
        return "published";
      },
    };
    const pending = finalizeCapacityBatch(harness, ["fixture"], (condition) => {
      if (!condition) throw new Error("capacity-failed");
    });
    pending.catch(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.workerReadiness).toHaveBeenCalledOnce();
    expect(calls).toBe(10);
    expect(settled).toBe(false);
    release();
    await expect(pending).rejects.toThrow("capacity-failed");
    expect(diagnostic).toHaveBeenCalledOnce();
  });
  it("observes real transaction attempts without replacing results or errors", async () => {
    const failure = { code: "P2034" };
    const prisma = {
      async $transaction(callback) {
        return callback();
      },
    };
    const activity = observeTransactions(prisma);
    expect(await prisma.$transaction(() => 42)).toBe(42);
    await expect(
      prisma.$transaction(() => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(activity).toEqual({ attempts: 2, failed: 1, retryableFailures: 1 });
  });
  it("uses nearest-rank P95 and rejects missing/nonfinite capacity samples", () => {
    expect(percentile(Array.from({ length: 100 }, (_, index) => index + 1))).toBe(95);
    expect(() => percentile([])).toThrow();
    expect(() => percentile([Number.NaN])).toThrow();
  });
});
