export { createAliyunOssObjectStore } from "./aliyun-oss.js";
export { createMinioObjectStore } from "./minio.js";
export type { ObjectStore, ObjectStoreConfig } from "./object-store.js";

import { createAliyunOssObjectStore } from "./aliyun-oss.js";
import { createMinioObjectStore } from "./minio.js";
import type { ObjectStore, ObjectStoreConfig } from "./object-store.js";

export function createObjectStore(config: ObjectStoreConfig): ObjectStore {
  return config.provider === "oss"
    ? createAliyunOssObjectStore(config)
    : createMinioObjectStore(config);
}
