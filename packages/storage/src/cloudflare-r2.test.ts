import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createCloudflareR2ObjectStore } from "./cloudflare-r2.js";
import type { ObjectStoreConfig } from "./object-store.js";

const mocks = vi.hoisted(() => ({
  clientConfigurations: [] as unknown[],
  getSignedUrl: vi.fn(),
  send: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  class MockS3Client {
    constructor(configuration: unknown) {
      mocks.clientConfigurations.push(configuration);
    }

    send(command: unknown, options?: unknown) {
      return mocks.send(command, options);
    }
  }
  return { ...actual, S3Client: MockS3Client };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: mocks.getSignedUrl }));

describe("Cloudflare R2 object store", () => {
  const config: ObjectStoreConfig = {
    accessKeyId: "r2-access-key",
    accessKeySecret: "r2-secret",
    bucket: "html-share",
    endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
    provider: "r2",
    region: "auto",
  };

  beforeEach(() => {
    mocks.clientConfigurations.length = 0;
    mocks.getSignedUrl.mockReset();
    mocks.send.mockReset();
  });

  it("uses virtual-hosted R2 clients and only checks the pre-created bucket", async () => {
    mocks.send.mockResolvedValueOnce({});
    const storage = createCloudflareR2ObjectStore(config);

    await storage.ensurePrivateBucket();

    expect(mocks.clientConfigurations).toHaveLength(2);
    expect(mocks.clientConfigurations[0]).toMatchObject({
      endpoint: config.endpoint,
      region: "auto",
    });
    expect(mocks.clientConfigurations[0]).not.toHaveProperty("forcePathStyle");
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]?.[0]).toBeInstanceOf(HeadBucketCommand);
  });

  it.each([
    [{ $metadata: { httpStatusCode: 404 } }, "R2_BUCKET_NOT_FOUND"],
    [{ name: "AccessDenied", $metadata: { httpStatusCode: 403 } }, "R2_AUTHENTICATION_FAILED"],
    [new Error("connect ECONNREFUSED"), "R2_BUCKET_UNREACHABLE"],
  ])(
    "classifies bucket reachability failures without exposing credentials",
    async (cause, code) => {
      mocks.send.mockRejectedValueOnce(cause);
      const storage = createCloudflareR2ObjectStore(config);

      let thrown: unknown;
      try {
        await storage.ensurePrivateBucket();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).toContain(code);
      expect(String(thrown)).not.toContain(config.accessKeySecret);
    },
  );

  it("binds content length, type and MD5 into the PUT signature", async () => {
    mocks.getSignedUrl.mockResolvedValueOnce("https://signed.example/upload");
    const storage = createCloudflareR2ObjectStore(config);

    await expect(
      storage.createPresignedUpload({
        contentLength: 128,
        contentMd5: "1B2M2Y8AsgTpgAmY7PhCfg==",
        contentType: "text/html; charset=utf-8",
        expiresInSeconds: 300,
        key: "projects/project-1/index.html",
      }),
    ).resolves.toEqual({
      headers: {
        "content-length": "128",
        "content-md5": "1B2M2Y8AsgTpgAmY7PhCfg==",
        "content-type": "text/html; charset=utf-8",
      },
      url: "https://signed.example/upload",
    });

    const command = mocks.getSignedUrl.mock.calls[0]?.[1];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({
      Bucket: config.bucket,
      ContentLength: 128,
      ContentMD5: "1B2M2Y8AsgTpgAmY7PhCfg==",
      ContentType: "text/html; charset=utf-8",
      Key: "projects/project-1/index.html",
    });
    expect(mocks.getSignedUrl.mock.calls[0]?.[2]).toMatchObject({ expiresIn: 300 });
    expect(mocks.getSignedUrl.mock.calls[0]?.[2]?.signableHeaders).toEqual(
      new Set(["content-length", "content-md5", "content-type"]),
    );
  });

  it("streams downloads and reports missing response bodies", async () => {
    const body = Readable.from(["hello"]);
    mocks.send.mockResolvedValueOnce({ Body: body }).mockResolvedValueOnce({});
    const storage = createCloudflareR2ObjectStore(config);

    await expect(storage.getObject("projects/1/index.html")).resolves.toBe(body);
    await expect(storage.getObject("projects/2/index.html")).rejects.toThrow(
      "OBJECT_BODY_UNAVAILABLE",
    );
    expect(mocks.send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
  });

  it("maps HeadObject metadata and treats only single-PUT ETags as MD5", async () => {
    mocks.send
      .mockResolvedValueOnce({
        ContentLength: 128,
        ContentType: "text/html",
        ETag: '"d41d8cd98f00b204e9800998ecf8427e"',
      })
      .mockResolvedValueOnce({ ContentLength: 256, ETag: '"abc-2"' })
      .mockRejectedValueOnce({ name: "NoSuchKey" });
    const storage = createCloudflareR2ObjectStore(config);

    await expect(storage.headObject("single")).resolves.toEqual({
      contentMd5: "1B2M2Y8AsgTpgAmY7PhCfg==",
      contentType: "text/html",
      size: 128,
    });
    await expect(storage.headObject("multipart")).resolves.toEqual({
      contentMd5: "",
      contentType: "application/octet-stream",
      size: 256,
    });
    await expect(storage.headObject("missing")).resolves.toBeNull();
    expect(mocks.send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
  });

  it("passes pagination inputs through and returns only valid object keys", async () => {
    mocks.send.mockResolvedValueOnce({
      Contents: [{ Key: "projects/1" }, {}, { Key: "" }],
      IsTruncated: true,
      NextContinuationToken: "next-page",
    });
    const storage = createCloudflareR2ObjectStore(config);

    await expect(
      storage.listObjects({ continuationToken: "current", maxKeys: 100, prefix: "projects/" }),
    ).resolves.toEqual({ keys: ["projects/1"], nextContinuationToken: "next-page" });
    const command = mocks.send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(ListObjectsV2Command);
    expect(command.input).toEqual({
      Bucket: config.bucket,
      ContinuationToken: "current",
      MaxKeys: 100,
      Prefix: "projects/",
    });
  });

  it("batches deletes and fails on partial deletion", async () => {
    mocks.send
      .mockResolvedValueOnce({ Errors: [] })
      .mockResolvedValueOnce({ Errors: [{ Code: "AccessDenied", Key: "projects/2" }] });
    const storage = createCloudflareR2ObjectStore(config);

    await expect(storage.deleteObjects(["projects/1", "projects/2"])).resolves.toBeUndefined();
    const command = mocks.send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(DeleteObjectsCommand);
    expect(command.input).toEqual({
      Bucket: config.bucket,
      Delete: {
        Objects: [{ Key: "projects/1" }, { Key: "projects/2" }],
        Quiet: true,
      },
    });
    await expect(storage.deleteObjects(["projects/2"])).rejects.toThrow(
      "OBJECT_DELETE_PARTIAL_FAILURE:projects/2",
    );
  });
});
