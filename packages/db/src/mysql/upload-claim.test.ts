import { expect, it, vi } from "vitest";
import { claimableUploadId } from "./upload-claim.js";
import type { MysqlTransactionClient } from "./types.js";

it("continues beyond a stale full page using literal boundaries even if its last row disappears", async () => {
  const createdAt = new Date("2026-11-04T00:00:00Z");
  const page = Array.from({ length: 32 }, (_item, index) => ({
    id: `candidate-${String(index).padStart(2, "0")}`,
    createdAt,
  }));
  const boundary = page.at(-1);
  if (!boundary) throw new Error("Expected full candidate page");
  const deleted = new Set<string>();
  let pages = 0;
  let locks = 0;
  const find = vi.fn().mockImplementation(async (input: { cursor?: { id: string } }) => {
    if (++pages === 1) return page;
    if (input.cursor && deleted.has(input.cursor.id)) return [];
    return [{ id: "next-page", createdAt: new Date(createdAt.getTime() + 1) }];
  });
  const query = vi.fn().mockImplementation(async () => {
    if (++locks <= 32) {
      // Competing claims changed the whole page; concurrent cleanup removed its tail.
      deleted.add(boundary.id);
      return [];
    }
    return [{ id: "next-page" }];
  });
  const tx = {
    uploadTask: { findMany: find },
    $queryRaw: query,
  } as unknown as MysqlTransactionClient;
  expect(await claimableUploadId(tx, new Date())).toBe("next-page");
  expect(query).toHaveBeenCalledTimes(33);
  expect(find.mock.calls[1]?.[0]).not.toHaveProperty("cursor");
  expect(find.mock.calls[1]?.[0]).toMatchObject({
    where: {
      AND: expect.arrayContaining([
        { OR: [{ createdAt: { gt: createdAt } }, { createdAt, id: { gt: boundary.id } }] },
      ]),
    },
  });
});
