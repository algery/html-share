import {
  CreateBucketCommand,
  DeleteBucketPolicyCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  PutBucketAclCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";

import type { ObjectStore, ObjectStoreConfig } from "./object-store.js";

export function createMinioObjectStore(config: ObjectStoreConfig): ObjectStore {
  const client = createS3Client(config, config.endpoint);
  const signingClient = createS3Client(config, config.publicEndpoint ?? config.endpoint);

  return {
    async ensurePrivateBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
      } catch (error) {
        if (!isNotFound(error)) throw error;
        await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
      }
      await client.send(new PutBucketAclCommand({ ACL: "private", Bucket: config.bucket }));
      await client.send(new DeleteBucketPolicyCommand({ Bucket: config.bucket })).catch((error) => {
        if (!isMissingPolicy(error)) throw error;
      });
    },
    async createPresignedZipUpload(input) {
      return {
        headers: {
          "content-length": String(input.contentLength),
          "content-type": "application/zip",
        },
        url: await getSignedUrl(
          signingClient,
          new PutObjectCommand({
            Bucket: config.bucket,
            ContentLength: input.contentLength,
            ContentType: "application/zip",
            Key: input.key,
          }),
          {
            expiresIn: input.expiresInSeconds,
            signableHeaders: new Set(["content-length", "content-type"]),
          },
        ),
      };
    },
    async getObject(key) {
      const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      if (!isReadable(result.Body)) throw new Error("OBJECT_BODY_UNAVAILABLE");
      return result.Body;
    },
    async headObject(key) {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
        );
        return { size: result.ContentLength ?? 0 };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async putObject(input) {
      await client.send(
        new PutObjectCommand({
          Body: input.body,
          Bucket: config.bucket,
          ContentLength: input.size,
          ContentType: input.contentType,
          Key: input.key,
        }),
      );
    },
    async deleteObjects(keys) {
      if (keys.length === 0) return;
      const result = await client.send(
        new DeleteObjectsCommand({
          Bucket: config.bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      assertDeleteCompleted(result.Errors);
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
    forcePathStyle: true,
    region: config.region,
  });
}

function isReadable(value: unknown): value is Readable {
  return value instanceof Readable;
}

function isNotFound(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (("$metadata" in error &&
      typeof error.$metadata === "object" &&
      error.$metadata !== null &&
      "httpStatusCode" in error.$metadata &&
      error.$metadata.httpStatusCode === 404) ||
      ("name" in error && (error.name === "NotFound" || error.name === "NoSuchBucket")))
  );
}

function isMissingPolicy(error: unknown) {
  return (
    isNotFound(error) ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error.name === "NoSuchBucketPolicy" || error.name === "NoSuchBucketPolicyError"))
  );
}

export function assertDeleteCompleted(
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
