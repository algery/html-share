import { describe, expect, it } from "vitest";

import { createCloudflareR2ObjectStore } from "./cloudflare-r2.js";
import type { ObjectStoreConfig } from "./object-store.js";

describe("Cloudflare R2 PUT signing", () => {
  const config: ObjectStoreConfig = {
    accessKeyId: "r2-access-key",
    accessKeySecret: "r2-secret",
    bucket: "html-share",
    endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
    provider: "r2",
    region: "auto",
  };

  it("creates a 300-second SigV4 URL that protects the key and required upload headers", async () => {
    const storage = createCloudflareR2ObjectStore(config);
    const input = {
      contentLength: 128,
      contentMd5: "1B2M2Y8AsgTpgAmY7PhCfg==",
      contentType: "text/html; charset=utf-8",
      expiresInSeconds: 300,
      key: "projects/project-1/index.html",
    };

    const signed = await storage.createPresignedUpload(input);
    const changedKey = await storage.createPresignedUpload({
      ...input,
      key: "projects/other/index.html",
    });
    const changedMd5 = await storage.createPresignedUpload({
      ...input,
      contentMd5: "AAAAAAAAAAAAAAAAAAAAAA==",
    });
    const changedExpiry = await storage.createPresignedUpload({ ...input, expiresInSeconds: 299 });
    const url = new URL(signed.url);

    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe(
      "html-share.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
    );
    expect(url.pathname).toBe("/projects/project-1/index.html");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Credential")).toContain("/auto/s3/aws4_request");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(
      expect.arrayContaining(["content-length", "content-md5", "content-type", "host"]),
    );
    expect(signed.headers).toEqual({
      "content-length": "128",
      "content-md5": input.contentMd5,
      "content-type": input.contentType,
    });
    expect(new URL(changedKey.url).searchParams.get("X-Amz-Signature")).not.toBe(
      url.searchParams.get("X-Amz-Signature"),
    );
    expect(new URL(changedMd5.url).searchParams.get("X-Amz-Signature")).not.toBe(
      url.searchParams.get("X-Amz-Signature"),
    );
    expect(new URL(changedExpiry.url).searchParams.get("X-Amz-Signature")).not.toBe(
      url.searchParams.get("X-Amz-Signature"),
    );
  });
});
