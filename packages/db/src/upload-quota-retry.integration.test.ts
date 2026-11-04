import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  MAX_STORAGE_BYTES_PER_USER,
  UPLOAD_URL_TTL_MS,
  type UploadRepository,
} from "@html-share/core";
import { createPrismaClient } from "./auth-repository.js";
import {
  DemoProjectStatus,
  QuotaReservationStatus,
  UploadTaskStatus,
} from "./generated/prisma/client.js";
import { createUploadRepository } from "./upload-repository.js";

const databaseUrl = process.env["PHASE25_QUOTA_URL"];
if (databaseUrl !== undefined) {
  const target = new URL(databaseUrl);
  if (
    !["postgresql:", "postgres:"].includes(target.protocol) ||
    !["localhost", "127.0.0.1"].includes(target.hostname) ||
    target.pathname !== "/html_share_phase25_quota"
  ) {
    throw new Error(
      "PHASE25_QUOTA_URL must target the dedicated local html_share_phase25_quota database",
    );
  }
}
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
type PrepareInput = Parameters<UploadRepository["prepare"]>[0];

describeDatabase("PostgreSQL upload retry quota integration", () => {
  const prisma = databaseUrl === undefined ? null : createPrismaClient(databaseUrl);
  const second = databaseUrl === undefined ? null : createPrismaClient(databaseUrl);
  const tenantIds: string[] = [];

  afterEach(async () => {
    if (prisma === null) return;
    for (const tenantId of tenantIds.splice(0)) {
      await prisma.demoProject.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await second?.$disconnect();
  });

  function requiredPrisma() {
    if (prisma === null) throw new Error("PHASE25_QUOTA_URL is required");
    return prisma;
  }

  async function fixture() {
    if (prisma === null) throw new Error("PHASE25_QUOTA_URL is required");
    const suffix = randomUUID();
    const now = new Date();
    const tenant = await prisma.tenant.create({
      data: { dingtalkAppKeyRef: `quota-retry-${suffix}`, name: "Quota retry" },
    });
    tenantIds.push(tenant.id);
    const owner = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        dingtalkUserId: suffix,
        displayName: "Quota retry",
        lastLoginAt: now,
      },
    });
    return { owner, now, repository: createUploadRepository(prisma) };
  }

  async function fillQuota(input: PrepareInput, quota: "count" | "bytes", reserved: boolean) {
    if (prisma === null) throw new Error("PHASE25_QUOTA_URL is required");
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: input.owner.id } });
    const count = quota === "count" ? (reserved ? 99 : 100) : 1;
    await prisma.demoProject.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        displayName: "Quota fixture",
        ownerUserId: owner.id,
        projectKey: `q${index.toString(36).padStart(4, "0")}`,
        status: DemoProjectStatus.ACTIVE,
        tenantId: owner.tenantId,
        totalSize: quota === "bytes" ? BigInt(MAX_STORAGE_BYTES_PER_USER - (reserved ? 1 : 0)) : 0n,
      })),
    });
    if (reserved) {
      await createUploadRepository(prisma).prepare({ ...input, clientRequestId: randomUUID() });
    }
  }

  const retries = ["failed", "expired"] as const;
  const quotas = ["count", "bytes"] as const;
  const cases = retries.flatMap((status) =>
    quotas.flatMap((quota) => [false, true].map((reserved) => ({ status, quota, reserved }))),
  );

  it.each(cases)(
    "rechecks $status create retry against $quota quota (reserved=$reserved)",
    async ({ status, quota, reserved }) => {
      const { owner, now, repository } = await fixture();
      const input = prepareInput(owner, now);
      const initial = await repository.prepare(input);
      const retryNow = status === "expired" ? new Date(now.getTime() + UPLOAD_URL_TTL_MS) : now;
      if (status === "failed") {
        expect(
          await repository.failUpload({ uploadId: initial.uploadId, failureCode: "TEST", now }),
        ).toBe(true);
      }
      await fillQuota({ ...input, now: retryNow }, quota, reserved);
      const taskCount = await requiredPrisma().uploadTask.count({
        where: { ownerUserId: owner.id },
      });
      const revisionCount = await requiredPrisma().revision.count({
        where: { project: { ownerUserId: owner.id } },
      });

      await expect(repository.prepare({ ...input, now: retryNow })).rejects.toMatchObject({
        code: quota === "count" ? "PROJECT_QUOTA_EXCEEDED" : "STORAGE_QUOTA_EXCEEDED",
      });
      expect(await requiredPrisma().uploadTask.count({ where: { ownerUserId: owner.id } })).toBe(
        taskCount,
      );
      expect(
        await requiredPrisma().revision.count({ where: { project: { ownerUserId: owner.id } } }),
      ).toBe(revisionCount);
      expect(
        await requiredPrisma().quotaReservation.findUniqueOrThrow({
          where: { uploadTaskId: initial.uploadId },
        }),
      ).toMatchObject({
        status: QuotaReservationStatus.RELEASED,
      });
    },
  );

  it.each(retries)(
    "allows $status create retry after capacity becomes available",
    async (status) => {
      const { owner, now, repository } = await fixture();
      const input = prepareInput(owner, now);
      const initial = await repository.prepare(input);
      const retryNow = status === "expired" ? new Date(now.getTime() + UPLOAD_URL_TTL_MS) : now;
      if (status === "failed")
        await repository.failUpload({ uploadId: initial.uploadId, failureCode: "TEST", now });
      const retried = await repository.prepare({ ...input, now: retryNow });
      expect(retried).toMatchObject({
        projectId: initial.projectId,
        status: "prepared",
        idempotent: false,
        revisionNumber: 2,
      });
      expect(retried.uploadId).not.toBe(initial.uploadId);
      expect(
        await requiredPrisma().quotaReservation.findUniqueOrThrow({
          where: { uploadTaskId: retried.uploadId },
        }),
      ).toMatchObject({
        projectDelta: 1,
        storageBytes: 1n,
        status: QuotaReservationStatus.RESERVED,
      });
    },
  );

  it.each(["prepared", "processing", "completed"] as const)(
    "does not charge an idempotent $status retry again",
    async (status) => {
      const { owner, now, repository } = await fixture();
      const input = prepareInput(owner, now);
      const initial = await repository.prepare(input);
      if (status === "processing")
        await repository.requestCompletion({
          uploadId: initial.uploadId,
          ownerUserId: owner.id,
          now,
        });
      if (status === "completed") {
        await repository.requestCompletion({
          uploadId: initial.uploadId,
          ownerUserId: owner.id,
          now,
        });
        await repository.markUploadFilesVerified({ uploadId: initial.uploadId, now });
        expect(await repository.publishUpload({ uploadId: initial.uploadId, now })).toBe(true);
      }
      await fillQuota(input, "count", false);
      expect(await repository.prepare(input)).toMatchObject({
        uploadId: initial.uploadId,
        status,
        idempotent: true,
      });
      expect(await requiredPrisma().quotaReservation.count({ where: { userId: owner.id } })).toBe(
        1,
      );
    },
  );

  it("allows replacement when both count and storage are at their limits", async () => {
    const { owner, now, repository } = await fixture();
    const input = prepareInput(owner, now);
    await fillQuota(input, "count", false);
    await requiredPrisma().demoProject.update({
      where: { projectKey: "q0000" },
      data: { totalSize: BigInt(MAX_STORAGE_BYTES_PER_USER) },
    });
    const replacement = await repository.prepare({
      ...input,
      action: "replace",
      projectId: "q0000",
    });
    expect(replacement).toMatchObject({ projectId: "q0000", status: "prepared" });
    expect(
      await requiredPrisma().quotaReservation.findUniqueOrThrow({
        where: { uploadTaskId: replacement.uploadId },
      }),
    ).toMatchObject({ projectDelta: 0, storageBytes: 0n });
  });

  it("serializes competing failed retries for the last project slot across connections", async () => {
    const { owner, now, repository } = await fixture();
    if (second === null) throw new Error("PHASE25_QUOTA_URL is required");
    const inputs = [prepareInput(owner, now), prepareInput(owner, now)];
    for (const input of inputs) {
      const prepared = await repository.prepare(input);
      await repository.failUpload({ uploadId: prepared.uploadId, failureCode: "TEST", now });
    }
    const storedOwner = await requiredPrisma().user.findUniqueOrThrow({ where: { id: owner.id } });
    await requiredPrisma().demoProject.createMany({
      data: Array.from({ length: 99 }, (_, index) => ({
        displayName: "Race fixture",
        ownerUserId: owner.id,
        tenantId: storedOwner.tenantId,
        projectKey: `r${index.toString(36).padStart(4, "0")}`,
        status: DemoProjectStatus.ACTIVE,
      })),
    });
    const outcomes = await Promise.allSettled(
      inputs.map((input, index) =>
        createUploadRepository(index === 0 ? requiredPrisma() : second).prepare(input),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: { code: "PROJECT_QUOTA_EXCEEDED" },
    });
    expect(
      await requiredPrisma().quotaReservation.aggregate({
        where: { userId: owner.id, status: QuotaReservationStatus.RESERVED },
        _sum: { projectDelta: true },
      }),
    ).toMatchObject({ _sum: { projectDelta: 1 } });
    expect(
      await requiredPrisma().uploadTask.count({
        where: { ownerUserId: owner.id, status: UploadTaskStatus.PREPARED },
      }),
    ).toBe(1);
  });
});

function prepareInput(owner: PrepareInput["owner"], now: Date): PrepareInput {
  return {
    action: "create",
    clientRequestId: randomUUID(),
    displayName: "Quota retry upload",
    fileCount: 1,
    files: [
      {
        contentMd5: "ndTkYSaMgDT1yFZOFVxnpg==",
        mimeType: "text/html; charset=utf-8",
        relativePath: "index.html",
        sha256: "a".repeat(64),
        size: 1,
      },
    ],
    manifestDigest: "a".repeat(64),
    now,
    owner,
    targetHtml: "index.html",
    totalSize: 1,
  };
}
