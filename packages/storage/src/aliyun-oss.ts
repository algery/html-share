import OSS from "ali-oss";
import type { Readable } from "node:stream";

import type { ObjectStore, ObjectStoreConfig } from "./object-store.js";

export function createAliyunOssObjectStore(config: ObjectStoreConfig): ObjectStore {
  const endpoint = new URL(config.endpoint);
  const client = new OSS({
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    authorizationV4: true,
    bucket: config.bucket,
    endpoint: endpoint.origin,
    region: config.region,
  });

  return {
    async ensurePrivateBucket() {
      await (client as OssBucketAclClient).putBucketACL(config.bucket, "private");
    },
    async createPresignedZipUpload(input) {
      const headers = {
        "Content-Length": String(input.contentLength),
        "Content-Type": "application/zip",
      };
      return {
        headers: {
          "content-length": String(input.contentLength),
          "content-type": "application/zip",
        },
        url: await client.signatureUrlV4("PUT", input.expiresInSeconds, { headers }, input.key, [
          "Content-Length",
          "Content-Type",
        ]),
      };
    },
    async getObject(key) {
      const result = await client.getStream(key);
      return result.stream as Readable;
    },
    async headObject(key) {
      try {
        const result = await client.head(key);
        const response = result.res as { headers?: Record<string, string | string[] | undefined> };
        const contentLength = response.headers?.["content-length"];
        return {
          size: Number(Array.isArray(contentLength) ? contentLength[0] : (contentLength ?? 0)),
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async putObject(input) {
      await client.putStream(input.key, input.body);
    },
    async deleteObjects(keys) {
      if (keys.length === 0) return;
      const result = (await client.deleteMulti([...keys], {
        quiet: false,
      })) as OssDeleteMultiResult;
      assertOssDeleteCompleted(keys, result.deleted ?? []);
    },
  };
}

type OssBucketAclClient = OSS & {
  putBucketACL(name: string, acl: "private"): Promise<unknown>;
};

interface OssDeleteMultiResult {
  deleted?: readonly unknown[];
}

export function assertOssDeleteCompleted(
  requestedKeys: readonly string[],
  deleted: readonly unknown[],
) {
  if (deleted.length === requestedKeys.length) return;
  throw new Error(`OBJECT_DELETE_PARTIAL_FAILURE:${requestedKeys.length - deleted.length}`);
}

function isNotFound(error: unknown) {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === "NoSuchKey"
  );
}
