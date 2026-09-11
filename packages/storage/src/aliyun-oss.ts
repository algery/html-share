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
    async createPresignedUpload(input) {
      const headers = {
        "Content-Length": String(input.contentLength),
        "Content-MD5": input.contentMd5,
        "Content-Type": input.contentType,
      };
      return {
        headers: {
          "content-length": String(input.contentLength),
          "content-md5": input.contentMd5,
          "content-type": input.contentType,
        },
        url: await client.signatureUrlV4("PUT", input.expiresInSeconds, { headers }, input.key, [
          "Content-Length",
          "Content-MD5",
          "Content-Type",
        ]),
      };
    },
    async getObject(key) {
      const result = await client.getStream(key);
      return result.stream as Readable;
    },
    async headObject(key, options) {
      try {
        const result = await (client as unknown as OssHeadClient).head(
          key,
          options?.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs },
        );
        const response = result.res as { headers?: Record<string, string | string[] | undefined> };
        const contentLength = response.headers?.["content-length"];
        const etag = firstHeader(response.headers?.["etag"]);
        const crc64 = firstHeader(response.headers?.["x-oss-hash-crc64ecma"]);
        return {
          contentMd5: firstHeader(response.headers?.["content-md5"]) ?? md5FromEtag(etag) ?? "",
          contentType:
            firstHeader(response.headers?.["content-type"]) ?? "application/octet-stream",
          ...(crc64 === undefined ? {} : { crc64 }),
          size: Number(Array.isArray(contentLength) ? contentLength[0] : (contentLength ?? 0)),
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async listObjects(input) {
      const result = await (client as unknown as OssListClient).listV2(
        {
          ...(input.continuationToken === undefined
            ? {}
            : { "continuation-token": input.continuationToken }),
          "max-keys": input.maxKeys,
          prefix: input.prefix,
        },
        input.timeoutMs === undefined ? undefined : { timeout: input.timeoutMs },
      );
      const keys = (result.objects ?? [])
        .map((object) => object.name)
        .filter((key): key is string => typeof key === "string" && key.length > 0);
      return {
        keys,
        ...(result.isTruncated === true && result.nextContinuationToken !== undefined
          ? { nextContinuationToken: result.nextContinuationToken }
          : {}),
      };
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

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function md5FromEtag(value: string | undefined) {
  const hex = value?.replaceAll('"', "");
  if (hex === undefined || !/^[a-f0-9]{32}$/i.test(hex)) return undefined;
  return Buffer.from(hex, "hex").toString("base64");
}

type OssBucketAclClient = OSS & {
  putBucketACL(name: string, acl: "private"): Promise<unknown>;
};

interface OssHeadClient {
  head(name: string, options?: { timeout?: number }): ReturnType<OSS["head"]>;
}

interface OssListClient {
  listV2(
    query: {
      "continuation-token"?: string;
      "max-keys": number;
      prefix: string;
    },
    options?: { timeout?: number },
  ): Promise<{
    isTruncated?: boolean;
    nextContinuationToken?: string;
    objects?: { name?: string }[];
  }>;
}

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
