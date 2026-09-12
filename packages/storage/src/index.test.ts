import { describe, expect, it, vi } from "vitest";

import { createObjectStore } from "./index.js";
import type { ObjectStoreConfig } from "./object-store.js";

const adapters = vi.hoisted(() => ({
  minio: { name: "minio" },
  oss: { name: "oss" },
  r2: { name: "r2" },
}));

vi.mock("./aliyun-oss.js", () => ({ createAliyunOssObjectStore: vi.fn(() => adapters.oss) }));
vi.mock("./cloudflare-r2.js", () => ({
  createCloudflareR2ObjectStore: vi.fn(() => adapters.r2),
}));
vi.mock("./minio.js", () => ({ createMinioObjectStore: vi.fn(() => adapters.minio) }));

describe("object store factory", () => {
  const config = {
    accessKeyId: "access-key",
    accessKeySecret: "secret",
    bucket: "bucket",
    endpoint: "https://storage.example.com",
    region: "region",
  } as const;

  it.each([
    ["minio", adapters.minio],
    ["oss", adapters.oss],
    ["r2", adapters.r2],
  ] as const)("selects only the explicit %s adapter", (provider, expected) => {
    expect(createObjectStore({ ...config, provider } as ObjectStoreConfig)).toBe(expected);
  });

  it("never falls back for an unsupported runtime value", () => {
    expect(() =>
      createObjectStore({ ...config, provider: "s3" } as unknown as ObjectStoreConfig),
    ).toThrow("OBJECT_STORAGE_PROVIDER_UNSUPPORTED");
  });
});
