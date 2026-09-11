import { Transform } from "node:stream";

import type { ObjectStore } from "./object-store.js";

export interface ObjectStoreActivity {
  bodyBytesRead: number;
  getObjectCalls: number;
}

/**
 * Instruments body reads at the worker's storage boundary. Scheme B should keep
 * both counters at zero during finalization; a future accidental GetObject call
 * becomes visible through the worker metrics endpoint.
 */
export function observeObjectStoreActivity(delegate: ObjectStore) {
  const activity: ObjectStoreActivity = { bodyBytesRead: 0, getObjectCalls: 0 };
  const storage: ObjectStore = {
    createPresignedUpload: (input) => delegate.createPresignedUpload(input),
    deleteObjects: (keys) => delegate.deleteObjects(keys),
    ensurePrivateBucket: () => delegate.ensurePrivateBucket(),
    headObject: (key, options) => delegate.headObject(key, options),
    listObjects: (input) => delegate.listObjects(input),
    async getObject(key) {
      activity.getObjectCalls += 1;
      const source = await delegate.getObject(key);
      const meter = new Transform({
        transform(chunk: Buffer | string, encoding, callback) {
          activity.bodyBytesRead +=
            typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
          callback(null, chunk);
        },
      });
      source.on("error", (error) => meter.destroy(error));
      return source.pipe(meter);
    },
  };
  return {
    snapshot: (): ObjectStoreActivity => ({ ...activity }),
    storage,
  };
}
