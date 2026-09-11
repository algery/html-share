import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createMinioObjectStore } from "./minio.js";

const endpoint = process.env["PHASE9_MINIO_ENDPOINT"];
const describeMinio = endpoint === undefined ? describe.skip : describe;

describeMinio("MinIO exact direct-upload integration", () => {
  it("accepts matching Content-MD5 and rejects different bytes without creating an object", async () => {
    if (endpoint === undefined) throw new Error("PHASE9_MINIO_ENDPOINT is required");
    const storage = createMinioObjectStore({
      accessKeyId: required("PHASE9_MINIO_ACCESS_KEY_ID"),
      accessKeySecret: required("PHASE9_MINIO_ACCESS_KEY_SECRET"),
      bucket: required("PHASE9_MINIO_BUCKET"),
      endpoint,
      provider: "minio",
      publicEndpoint: endpoint,
      region: "us-east-1",
    });
    await storage.ensurePrivateBucket();
    const failedKey = `integration/direct/${randomUUID()}/bad.html`;
    const expected = Buffer.from("good");
    const signed = await storage.createPresignedUpload({
      contentLength: expected.length,
      contentMd5: createHash("md5").update(expected).digest("base64"),
      contentType: "text/html; charset=utf-8",
      expiresInSeconds: 300,
      key: failedKey,
    });
    const rejected = await fetch(signed.url, {
      body: Buffer.from("evil"),
      headers: signed.headers,
      method: "PUT",
    });
    expect(rejected.ok).toBe(false);
    expect(await storage.headObject(failedKey)).toBeNull();

    const acceptedPrefix = `integration/direct/${randomUUID()}/`;
    const acceptedKey = `${acceptedPrefix}index.html`;
    const acceptedMd5 = createHash("md5").update(expected).digest("base64");
    const acceptedSigned = await storage.createPresignedUpload({
      contentLength: expected.length,
      contentMd5: acceptedMd5,
      contentType: "text/html; charset=utf-8",
      expiresInSeconds: 300,
      key: acceptedKey,
    });
    const accepted = await fetch(acceptedSigned.url, {
      body: expected,
      headers: acceptedSigned.headers,
      method: "PUT",
    });
    expect(accepted.ok).toBe(true);
    expect(await storage.headObject(acceptedKey)).toMatchObject({
      contentMd5: acceptedMd5,
      contentType: "text/html; charset=utf-8",
      size: expected.length,
    });
    const secondKey = `${acceptedPrefix}second.html`;
    const secondSigned = await storage.createPresignedUpload({
      contentLength: expected.length,
      contentMd5: acceptedMd5,
      contentType: "text/html; charset=utf-8",
      expiresInSeconds: 300,
      key: secondKey,
    });
    expect(
      (
        await fetch(secondSigned.url, {
          body: expected,
          headers: secondSigned.headers,
          method: "PUT",
        })
      ).ok,
    ).toBe(true);
    const firstPage = await storage.listObjects({
      maxKeys: 1,
      prefix: acceptedPrefix,
    });
    expect(firstPage.keys).toHaveLength(1);
    expect(firstPage.nextContinuationToken).toBeDefined();
    const continuationToken = firstPage.nextContinuationToken;
    if (continuationToken === undefined) throw new Error("expected a second object page");
    const secondPage = await storage.listObjects({
      continuationToken,
      maxKeys: 1,
      prefix: acceptedPrefix,
    });
    expect(new Set([...firstPage.keys, ...secondPage.keys])).toEqual(
      new Set([acceptedKey, secondKey]),
    );
    await storage.deleteObjects([acceptedKey, secondKey]);
  });
});

function required(name: string) {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}
