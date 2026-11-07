import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";

import type { ObjectStore, ObjectStoreConfig } from "./object-store.js";

export function createCloudflareR2ObjectStore(config: ObjectStoreConfig): ObjectStore {
  const client = createS3Client(config, config.endpoint);
  const signingClient = createS3Client(config, config.publicEndpoint ?? config.endpoint);

  return {
    async ensurePrivateBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
      } catch (error) {
        throw classifyBucketAccessError(error);
      }
    },
    async createPresignedUpload(input) {
      const headers = {
        "content-length": String(input.contentLength),
        "content-md5": input.contentMd5,
        "content-type": input.contentType,
      };
      return {
        headers,
        url: await getSignedUrl(
          input.internal ? client : signingClient,
          new PutObjectCommand({
            Bucket: config.bucket,
            ContentLength: input.contentLength,
            ContentMD5: input.contentMd5,
            ContentType: input.contentType,
            Key: input.key,
          }),
          {
            expiresIn: input.expiresInSeconds,
            signableHeaders: new Set(Object.keys(headers)),
          },
        ),
      };
    },
    async getObject(key, options) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
        options?.abortSignal === undefined ? undefined : { abortSignal: options.abortSignal },
      );
      if (!isReadable(result.Body)) throw new Error("OBJECT_BODY_UNAVAILABLE");
      return result.Body;
    },
    async headObject(key, options) {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
          options?.abortSignal === undefined ? undefined : { abortSignal: options.abortSignal },
        );
        return {
          contentMd5: md5FromSinglePutEtag(result.ETag),
          contentType: result.ContentType ?? "application/octet-stream",
          size: result.ContentLength ?? 0,
        };
      } catch (error) {
        if (isObjectNotFound(error)) return null;
        throw error;
      }
    },
    async listObjects(input) {
      const result = await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          ContinuationToken: input.continuationToken,
          MaxKeys: input.maxKeys,
          Prefix: input.prefix,
        }),
        input.abortSignal === undefined ? undefined : { abortSignal: input.abortSignal },
      );
      const keys = (result.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => key !== undefined && key.length > 0);
      return {
        keys,
        ...(result.IsTruncated === true && result.NextContinuationToken !== undefined
          ? { nextContinuationToken: result.NextContinuationToken }
          : {}),
      };
    },
    async deleteObjects(keys) {
      if (keys.length === 0) return;
      const result = await client.send(
        new DeleteObjectsCommand({
          Bucket: config.bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      assertR2DeleteCompleted(result.Errors);
    },
  };
}

function createS3Client(config: ObjectStoreConfig, endpoint: string) {
  return new S3Client({
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.accessKeySecret,
    },
    endpoint,
    region: config.region,
  });
}

function isReadable(value: unknown): value is Readable {
  return value instanceof Readable;
}

function md5FromSinglePutEtag(etag: string | undefined) {
  const hex = etag?.replaceAll('"', "");
  if (hex === undefined || !/^[a-f0-9]{32}$/i.test(hex)) return "";
  return Buffer.from(hex, "hex").toString("base64");
}

function isObjectNotFound(error: unknown) {
  return (
    hasHttpStatus(error, 404) || hasErrorName(error, "NotFound") || hasErrorName(error, "NoSuchKey")
  );
}

function classifyBucketAccessError(error: unknown) {
  if (
    hasHttpStatus(error, 404) ||
    hasErrorName(error, "NotFound") ||
    hasErrorName(error, "NoSuchBucket")
  ) {
    return new Error("R2_BUCKET_NOT_FOUND", { cause: error });
  }
  if (
    hasHttpStatus(error, 401) ||
    hasHttpStatus(error, 403) ||
    hasErrorName(error, "AccessDenied") ||
    hasErrorName(error, "InvalidAccessKeyId") ||
    hasErrorName(error, "SignatureDoesNotMatch")
  ) {
    return new Error("R2_AUTHENTICATION_FAILED", { cause: error });
  }
  return new Error("R2_BUCKET_UNREACHABLE", { cause: error });
}

function hasHttpStatus(error: unknown, status: number) {
  return (
    typeof error === "object" &&
    error !== null &&
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata !== null &&
    "httpStatusCode" in error.$metadata &&
    error.$metadata.httpStatusCode === status
  );
}

function hasErrorName(error: unknown, name: string) {
  return typeof error === "object" && error !== null && "name" in error && error.name === name;
}

export function assertR2DeleteCompleted(
  errors:
    | readonly {
        Code?: string | undefined;
        Key?: string | undefined;
        Message?: string | undefined;
      }[]
    | undefined,
) {
  if (errors === undefined || errors.length === 0) return;
  throw new Error(
    `OBJECT_DELETE_PARTIAL_FAILURE:${errors.map((error) => error.Key ?? "unknown").join(",")}`,
  );
}
