import { expect, it } from "vitest";
import { databaseContract } from "./database-contract-fixture.mjs";

databaseContract("independent single-row upload claims", (current) => {
  it("continues past a full locked page to the next eligible task", async () => {
    const fixture = current();
    const tasks = await Promise.all(
      Array.from({ length: 33 }, () => fixture.service.prepare(fixture.request())),
    );
    for (const task of tasks) await fixture.ready(task);
    const ordered = await fixture.db.uploadTask.findMany({
      where: { ownerUserId: fixture.owner.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    let announce;
    let release;
    const held = new Promise((resolve) => {
      announce = resolve;
    });
    const unlocked = new Promise((resolve) => {
      release = resolve;
    });
    const pending = fixture.db.$transaction(
      async (tx) => {
        for (const { id } of ordered.slice(0, 32)) {
          if (fixture.provider === "mysql")
            await tx.$queryRaw`SELECT id FROM upload_tasks WHERE id = ${id} FOR UPDATE`;
          else await tx.$queryRaw`SELECT id FROM upload_tasks WHERE id = ${id}::uuid FOR UPDATE`;
        }
        announce();
        await unlocked;
      },
      { timeout: 10000 },
    );
    try {
      await Promise.race([
        held,
        pending.then(() => {
          throw new Error("Locking transaction ended early");
        }),
      ]);
      const claim = await fixture.second.uploads.claimNextProcessingUpload(fixture.now);
      expect(claim?.uploadId).toBe(ordered[32].id);
    } finally {
      release();
      await pending;
    }
  });

  it("lets ten concurrent claimers receive distinct pending tasks without locking the sorted queue", async () => {
    const fixture = current();
    const tasks = await Promise.all(
      Array.from({ length: 10 }, () => fixture.service.prepare(fixture.request())),
    );
    for (const task of tasks) await fixture.ready(task);
    const claimed = await Promise.all(
      tasks.map((_task, index) =>
        (index % 2 ? fixture.second : fixture.repositories).uploads.claimNextProcessingUpload(
          fixture.now,
        ),
      ),
    );
    expect(claimed).not.toContain(null);
    expect(new Set(claimed.map((task) => task.uploadId))).toEqual(
      new Set(tasks.map((task) => task.uploadId)),
    );
    expect(await fixture.repositories.uploads.claimNextProcessingUpload(fixture.now)).toBeNull();
  });
});
