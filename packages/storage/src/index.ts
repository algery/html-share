export { createAliyunOssObjectStore } from "./aliyun-oss.js";
export { createCloudflareR2ObjectStore } from "./cloudflare-r2.js";
export { createMinioObjectStore } from "./minio.js";
export type {
  ListObjectsInput,
  ListObjectsResult,
  ObjectStore,
  ObjectStoreConfig,
} from "./object-store.js";
export { observeObjectStoreActivity } from "./object-store-activity.js";
export type { ObjectStoreActivity } from "./object-store-activity.js";

import { createAliyunOssObjectStore } from "./aliyun-oss.js";
import { createCloudflareR2ObjectStore } from "./cloudflare-r2.js";
import { createMinioObjectStore } from "./minio.js";
import type { ObjectStore, ObjectStoreConfig } from "./object-store.js";

export function createObjectStore(config: ObjectStoreConfig): ObjectStore {
  switch (config.provider) {
    case "minio":
      return createMinioObjectStore(config);
    case "oss":
      return createAliyunOssObjectStore(config);
    case "r2":
      return createCloudflareR2ObjectStore(config);
    default:
      throw new Error("OBJECT_STORAGE_PROVIDER_UNSUPPORTED");
  }
}
