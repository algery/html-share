import { describe, expect, it } from "vitest";

import { readServerEnv, readWorkerEnv } from "./environment.js";

describe("object-storage environment validation", () => {
  const infrastructureEnvironment = {
    DATABASE_URL: "postgresql://html_share:local@127.0.0.1:5432/html_share",
    OBJECT_STORAGE_ACCESS_KEY_ID: "local-access-key",
    OBJECT_STORAGE_ACCESS_KEY_SECRET: "r2-secret-that-must-not-leak",
    OBJECT_STORAGE_BUCKET: "html-share-local",
    OBJECT_STORAGE_ENDPOINT: "https://0123456789abcdef0123456789abcdef.us.r2.cloudflarestorage.com",
    OBJECT_STORAGE_PROVIDER: "r2",
    OBJECT_STORAGE_PUBLIC_ENDPOINT:
      "https://0123456789abcdef0123456789abcdef.us.r2.cloudflarestorage.com",
    OBJECT_STORAGE_REGION: "auto",
  } as const;
  const serverEnvironment = {
    APP_AUTH_URL: "http://app.localhost:3001",
    APP_HOST: "app.localhost",
    APP_WEB_URL: "http://app.localhost:3000",
    AUTH_STATE_SECRET: "test-state-signing-secret-with-enough-length",
    MCP_TOKEN_HASH_SECRET: "test-mcp-token-hash-secret-with-enough-length",
    PASSWORD_MANAGEMENT_ENCRYPTION_KEY: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
    PASSWORD_RESULT_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
    DEMO_AUTH_URL: "http://demo.localhost:3001",
    DEMO_HOST: "demo.localhost",
    DEMO_WEB_URL: "http://demo.localhost:3001",
    ...infrastructureEnvironment,
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: "3001",
  } as const;
  const workerEnvironment = {
    ...infrastructureEnvironment,
    WORKER_HOST: "127.0.0.1",
    WORKER_PORT: "3002",
  } as const;

  it("applies the same validated R2 contract to server and worker", () => {
    expect(readServerEnv(serverEnvironment)).toMatchObject({
      OBJECT_STORAGE_PROVIDER: "r2",
      OBJECT_STORAGE_REGION: "auto",
    });
    expect(readWorkerEnv(workerEnvironment)).toMatchObject({
      OBJECT_STORAGE_PROVIDER: "r2",
      OBJECT_STORAGE_REGION: "auto",
    });
    for (const jurisdiction of ["", ".us", ".eu", ".fedramp"]) {
      expect(() =>
        readWorkerEnv({
          ...workerEnvironment,
          OBJECT_STORAGE_ENDPOINT: `https://0123456789abcdef0123456789abcdef${jurisdiction}.r2.cloudflarestorage.com`,
          OBJECT_STORAGE_PUBLIC_ENDPOINT: undefined,
        }),
      ).not.toThrow();
    }
  });

  it("fails safely for invalid R2 endpoints and regions in both processes", () => {
    for (const read of [
      () =>
        readServerEnv({
          ...serverEnvironment,
          OBJECT_STORAGE_ENDPOINT: "https://assets.example.com",
          OBJECT_STORAGE_REGION: "us-east-1",
        }),
      () =>
        readWorkerEnv({
          ...workerEnvironment,
          OBJECT_STORAGE_ENDPOINT:
            "http://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
          OBJECT_STORAGE_REGION: "us-east-1",
        }),
    ]) {
      expect(read).toThrowError(/OBJECT_STORAGE_ENDPOINT, OBJECT_STORAGE_REGION/);
      try {
        read();
      } catch (error) {
        expect(String(error)).not.toContain(
          infrastructureEnvironment.OBJECT_STORAGE_ACCESS_KEY_SECRET,
        );
      }
    }
  });

  it("rejects unsupported providers and non-S3 R2 endpoints", () => {
    expect(() =>
      readWorkerEnv({ ...workerEnvironment, OBJECT_STORAGE_PROVIDER: "s3" }),
    ).toThrowError(/OBJECT_STORAGE_PROVIDER/);
    for (const endpoint of [
      "https://bucket.0123456789abcdef0123456789abcdef.r2.dev",
      "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/path",
      "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com:8443",
    ]) {
      expect(() =>
        readWorkerEnv({ ...workerEnvironment, OBJECT_STORAGE_ENDPOINT: endpoint }),
      ).toThrowError(/OBJECT_STORAGE_ENDPOINT/);
    }
    expect(() =>
      readWorkerEnv({
        ...workerEnvironment,
        OBJECT_STORAGE_PUBLIC_ENDPOINT: "https://cdn.example.com",
      }),
    ).toThrowError(/OBJECT_STORAGE_PUBLIC_ENDPOINT/);
  });

  it("requires both R2 endpoints to use the same account and jurisdiction", () => {
    for (const publicEndpoint of [
      "https://fedcba9876543210fedcba9876543210.us.r2.cloudflarestorage.com",
      "https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com",
    ]) {
      expect(() =>
        readWorkerEnv({ ...workerEnvironment, OBJECT_STORAGE_PUBLIC_ENDPOINT: publicEndpoint }),
      ).toThrowError(/OBJECT_STORAGE_PUBLIC_ENDPOINT/);
    }
  });
});
