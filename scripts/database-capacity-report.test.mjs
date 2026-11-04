import { describe, expect, it, vi } from "vitest";
import { requireCapacityReadiness } from "./database-capacity-report.mjs";
import { finalizeCapacityBatch } from "./database-capacity-publication.mjs";

const evidence = {
  sql: true,
  checksums: true,
  identity: true,
  deploymentReceipts: true,
  serverOnRequest: true,
  workerPolling: true,
  startupRoles: 2,
  serverChecks: 220,
  workerChecks: 2,
};
const report = (readiness) => ({ readiness, uploads: { finalizationRounds: [{}, {}] } });

describe("capacity production readiness evidence", () => {
  it("requires SQL, checksums, identity and both role receipts in the mandatory report", () => {
    expect(() => requireCapacityReadiness(report(evidence))).not.toThrow();
    expect(() => requireCapacityReadiness({})).toThrow();
    for (const key of Object.keys(evidence)) {
      const incomplete = { ...evidence };
      delete incomplete[key];
      expect(() => requireCapacityReadiness(report(incomplete))).toThrow();
      expect(() => requireCapacityReadiness(report({ ...evidence, [key]: false }))).toThrow();
    }
    expect(() => requireCapacityReadiness(report({ ...evidence, workerChecks: 1 }))).toThrow();
    expect(() => requireCapacityReadiness(report({ ...evidence, serverChecks: 0 }))).toThrow();
  });

  it("stops the worker round before all finalizers when readiness fails", async () => {
    const harness = {
      workerReadiness: vi.fn().mockRejectedValue(new Error("not ready")),
      finalize: vi.fn(),
    };
    await expect(finalizeCapacityBatch(harness, ["upload"], () => {})).rejects.toThrow("not ready");
    expect(harness.workerReadiness).toHaveBeenCalledOnce();
    expect(harness.finalize).not.toHaveBeenCalled();
  });

  it("performs one readiness check before ten parallel finalizers per worker round", async () => {
    let ready = false;
    const harness = {
      tenantId: "fixture",
      workerReadiness: vi.fn(async () => {
        ready = true;
      }),
      finalize: vi.fn(async () => {
        expect(ready).toBe(true);
        return "published";
      }),
      prisma: { uploadTask: { findMany: async () => [{ id: "upload", status: "COMPLETED" }] } },
    };
    const result = await finalizeCapacityBatch(harness, ["upload"], (condition) =>
      expect(condition).toBe(true),
    );
    expect(result.rounds).toHaveLength(1);
    expect(harness.workerReadiness).toHaveBeenCalledOnce();
    expect(harness.finalize).toHaveBeenCalledTimes(10);
  });
});
