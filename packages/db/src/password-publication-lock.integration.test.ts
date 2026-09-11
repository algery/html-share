import { createUploadService, digestManifest } from "@html-share/core";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "./auth-repository.js";
import { createUploadRepository } from "./upload-repository.js";
import { createPublicationRaceFixture } from "./upload-publication-race.test-helper.js";

const url = process.env["PHASE9_DATABASE_URL"];
const suite = url === undefined ? describe.skip : describe;
suite("password result lock ordering", () => {
  const prisma = createPrismaClient(url ?? "postgresql://unused:unused@localhost:1/unused");
  afterAll(() => prisma.$disconnect());

  it.each(["getStatus", "requestCompletion", "prepare"] as const)(
    "%s does not hold expired-task locks while waiting for the project",
    async (method) => {
      const now = new Date();
      const fixture = await createPublicationRaceFixture(
        prisma,
        now,
        new Date(now.getTime() - 5000),
      );
      let releaseProject: () => void = () => undefined;
      const projectReady = new Promise<void>((resolve) => {
        releaseProject = resolve;
      });
      let startDeletionWrites: () => void = () => undefined;
      const deletionGate = new Promise<void>((resolve) => {
        startDeletionWrites = resolve;
      });
      let lockTransaction: Promise<void> | undefined;
      let result: Promise<unknown> | undefined;
      try {
        const previousTask = await prisma.uploadTask.create({
          data: {
            tenantId: fixture.tenantId,
            ownerUserId: fixture.ownerId,
            projectId: fixture.projectId,
            revisionId: fixture.oldRevisionId,
            action: "CREATE",
            status: "COMPLETED",
            displayName: "old",
            targetHtml: "index.html",
            declaredFileCount: 1,
            declaredTotalSize: 3n,
            manifestDigest: "a".repeat(64),
            clientRequestId: randomUUID(),
            expiresAt: now,
          },
        });
        // This transaction performs deletion's project→task write order, with a barrier
        // at the project lock so the result reader must wait at its real SQL lock.
        lockTransaction = prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "demo_projects" WHERE "id" = ${fixture.projectId}::uuid FOR UPDATE`;
            releaseProject();
            await deletionGate;
            await tx.uploadTask.update({
              where: { id: fixture.uploadId },
              data: { status: "FAILED" },
            });
            await tx.demoProject.update({
              where: { id: fixture.projectId },
              data: { status: "DELETED" },
            });
          },
          { timeout: 8000 },
        );
        await projectReady;
        const repository = createUploadRepository(prisma);
        if (method === "prepare") {
          const files = [
            {
              relativePath: "index.html",
              size: 3,
              sha256: "a".repeat(64),
              contentMd5: "kAFQmDzST7DWlj99KOF/cg==",
              mimeType: "text/html; charset=utf-8",
            },
          ];
          result = createUploadService({ repository })
            .prepare({
              action: "replace",
              projectId: fixture.projectKey,
              owner: { id: fixture.ownerId, dingtalkUserId: "test", displayName: "test" },
              files,
              manifestDigest: digestManifest(files),
              displayName: "new",
              targetHtml: "index.html",
              clientRequestId: randomUUID(),
            })
            .then(
              () => {
                throw new Error("Must not prepare a deleted project");
              },
              (error: unknown) => {
                expect(error).toMatchObject({ code: "PROJECT_NOT_FOUND" });
              },
            );
        } else
          result = repository[method]({
            ownerUserId: fixture.ownerId,
            uploadId: previousTask.id,
            now,
          });
        const observed = await waitForProjectShareLock();
        expect(observed).toBe(true);
        startDeletionWrites();
        await expect(Promise.all([lockTransaction, result])).resolves.toHaveLength(2);
      } finally {
        startDeletionWrites();
        await Promise.allSettled([lockTransaction, result]);
        await prisma.demoProject.deleteMany({ where: { tenantId: fixture.tenantId } });
        await prisma.user.deleteMany({ where: { tenantId: fixture.tenantId } });
        await prisma.tenant.delete({ where: { id: fixture.tenantId } });
      }
    },
    15000,
  );

  async function waitForProjectShareLock() {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRaw<{ blocked: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND pid <> pg_backend_pid() AND state = 'active' AND wait_event_type = 'Lock'
          AND query LIKE '%demo_projects%' AND (query LIKE '%FOR SHARE%' OR query LIKE '%FOR UPDATE%')) AS "blocked"`;
      if (rows[0]?.blocked) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }
});
