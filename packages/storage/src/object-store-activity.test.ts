import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import type { ObjectStore } from "./object-store.js";
import { observeObjectStoreActivity } from "./object-store-activity.js";

describe("observeObjectStoreActivity", () => {
  it("keeps body counters at zero for metadata-only operations", async () => {
    const observed = observeObjectStoreActivity(fakeStore());

    await observed.storage.headObject("index.html");

    expect(observed.snapshot()).toEqual({ bodyBytesRead: 0, getObjectCalls: 0 });
  });

  it("counts calls and consumed body bytes when GetObject is used", async () => {
    const observed = observeObjectStoreActivity(fakeStore());
    const body = await observed.storage.getObject("index.html");

    for await (const chunk of body) void chunk;

    expect(observed.snapshot()).toEqual({ bodyBytesRead: 6, getObjectCalls: 1 });
  });
});

function fakeStore(): ObjectStore {
  return {
    async createPresignedUpload() {
      return { headers: {}, url: "https://storage.test/upload" };
    },
    async deleteObjects() {
      return undefined;
    },
    async ensurePrivateBucket() {
      return undefined;
    },
    async getObject() {
      return Readable.from([Buffer.from("direct")]);
    },
    async headObject() {
      return { contentMd5: "", contentType: "text/html", size: 6 };
    },
    async listObjects() {
      return { keys: [] };
    },
  };
}
