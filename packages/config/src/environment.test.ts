import { describe, expect, it } from "vitest";

import {
  EnvironmentValidationError,
  readDingTalkEnv,
  readServerEnv,
  readWebEnv,
  readWorkerEnv,
} from "./environment.js";

describe("environment validation", () => {
  const infrastructureEnvironment = {
    DATABASE_URL: "postgresql://html_share:local@127.0.0.1:5432/html_share",
    OBJECT_STORAGE_ACCESS_KEY_ID: "local-access-key",
    OBJECT_STORAGE_ACCESS_KEY_SECRET: "local-secret",
    OBJECT_STORAGE_BUCKET: "html-share-local",
    OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
    OBJECT_STORAGE_PROVIDER: "minio",
    OBJECT_STORAGE_REGION: "local",
  } as const;

  it("parses the Phase 1 service environments", () => {
    expect(
      readWebEnv({
        NEXT_PUBLIC_API_URL: "http://app.localhost:3001",
        NEXT_PUBLIC_APP_URL: "http://app.localhost:3000",
        NEXT_PUBLIC_DEMO_URL: "http://demo.localhost:3001",
      }),
    ).toEqual({
      NEXT_PUBLIC_API_URL: "http://app.localhost:3001",
      NEXT_PUBLIC_APP_URL: "http://app.localhost:3000",
      NEXT_PUBLIC_DEMO_URL: "http://demo.localhost:3001",
    });

    const server = readServerEnv({
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
      SERVER_HOST: "0.0.0.0",
      SERVER_PORT: "3001",
    });
    expect(server.SERVER_PORT).toBe(3001);
    expect(server).toMatchObject({
      AUTH_RATE_LIMIT_PER_MINUTE: 30,
      CONTENT_IP_RATE_LIMIT_PER_MINUTE: 1200,
      CONTENT_SESSION_RATE_LIMIT_PER_MINUTE: 600,
      MCP_RATE_LIMIT_PER_MINUTE: 60,
      MCP_UPLOAD_COMPLETE_RATE_LIMIT_PER_MINUTE: 10,
      MCP_UPLOAD_PREPARE_RATE_LIMIT_PER_MINUTE: 10,
    });
    expect(server.TRUSTED_PROXY_IPS).toBeUndefined();

    expect(
      readServerEnv({
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
        SERVER_HOST: "0.0.0.0",
        SERVER_PORT: "3001",
        TRUSTED_PROXY_IPS: "",
      }).TRUSTED_PROXY_IPS,
    ).toBeUndefined();

    expect(
      readServerEnv({
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
        SERVER_HOST: "0.0.0.0",
        SERVER_PORT: "3001",
        TRUSTED_PROXY_IPS: "172.30.0.2, 172.30.0.3",
      }).TRUSTED_PROXY_IPS,
    ).toEqual(["172.30.0.2", "172.30.0.3"]);

    expect(
      readWorkerEnv({
        ...infrastructureEnvironment,
        WORKER_HOST: "0.0.0.0",
        WORKER_PORT: "3002",
      }),
    ).toMatchObject({
      UPLOAD_FINALIZATION_CONCURRENCY: 10,
      UPLOAD_HEAD_OBJECT_TIMEOUT_MS: 10_000,
      WORKER_PORT: 3002,
    });
  });

  it("fails immediately while naming only invalid variables", () => {
    const marker = "fake-sensitive-value-that-must-not-leak";

    expect(() =>
      readDingTalkEnv({
        DINGTALK_API_BASE_URL: "https://api.dingtalk.com",
        DINGTALK_APP_ID: "",
        DINGTALK_AUTH_MODE: "live",
        DINGTALK_CLIENT_ID: "",
        DINGTALK_CLIENT_SECRET: marker,
        DINGTALK_EXTERNAL_AUTHORIZE_URL: "https://login.dingtalk.com/oauth2/auth",
      }),
    ).toThrowError(EnvironmentValidationError);

    try {
      readDingTalkEnv({
        DINGTALK_API_BASE_URL: "https://api.dingtalk.com",
        DINGTALK_APP_ID: "",
        DINGTALK_AUTH_MODE: "live",
        DINGTALK_CLIENT_ID: "",
        DINGTALK_CLIENT_SECRET: marker,
        DINGTALK_EXTERNAL_AUTHORIZE_URL: "https://login.dingtalk.com/oauth2/auth",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect(String(error)).toContain("DINGTALK_APP_ID");
      expect(String(error)).toContain("DINGTALK_CLIENT_ID");
      expect(String(error)).not.toContain(marker);
    }
  });

  it("accepts empty optional simulator credentials injected by Compose", () => {
    expect(
      readDingTalkEnv({
        DINGTALK_AUTH_MODE: "simulator",
        DINGTALK_CLIENT_SECRET: "",
      }),
    ).toEqual({
      DINGTALK_AUTH_MODE: "simulator",
      DINGTALK_CLIENT_SECRET: undefined,
    });
  });

  it("rejects invalid URLs and ports", () => {
    expect(() =>
      readWebEnv({
        NEXT_PUBLIC_API_URL: "file:///tmp/api",
        NEXT_PUBLIC_APP_URL: "not-a-url",
        NEXT_PUBLIC_DEMO_URL: "http://demo.localhost:3001",
      }),
    ).toThrowError(/NEXT_PUBLIC_API_URL, NEXT_PUBLIC_APP_URL/);

    expect(() =>
      readServerEnv({
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
        SERVER_HOST: "0.0.0.0",
        SERVER_PORT: "70000",
      }),
    ).toThrowError(/SERVER_PORT/);
  });

  it("rejects unsafe rate-limit settings", () => {
    expect(() =>
      readServerEnv({
        APP_AUTH_URL: "http://app.localhost:3001",
        APP_HOST: "app.localhost",
        APP_WEB_URL: "http://app.localhost:3000",
        AUTH_RATE_LIMIT_PER_MINUTE: "0",
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
      }),
    ).toThrowError(/AUTH_RATE_LIMIT_PER_MINUTE/);
  });

  it("requires database and object-storage configuration for service startup", () => {
    expect(() =>
      readServerEnv({
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
        SERVER_HOST: "127.0.0.1",
        SERVER_PORT: "3001",
      }),
    ).toThrowError(
      /DATABASE_URL, OBJECT_STORAGE_ACCESS_KEY_ID, OBJECT_STORAGE_ACCESS_KEY_SECRET, OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_ENDPOINT, OBJECT_STORAGE_PROVIDER, OBJECT_STORAGE_REGION/,
    );
  });

  it("requires the dedicated MCP Token HMAC secret without echoing values", () => {
    expect(() =>
      readServerEnv({
        APP_AUTH_URL: "http://app.localhost:3001",
        APP_HOST: "app.localhost",
        APP_WEB_URL: "http://app.localhost:3000",
        AUTH_STATE_SECRET: "test-state-signing-secret-with-enough-length",
        DEMO_AUTH_URL: "http://demo.localhost:3001",
        DEMO_HOST: "demo.localhost",
        DEMO_WEB_URL: "http://demo.localhost:3001",
        ...infrastructureEnvironment,
        SERVER_HOST: "127.0.0.1",
        SERVER_PORT: "3001",
      }),
    ).toThrowError(/MCP_TOKEN_HASH_SECRET/);
  });

  it("rejects schemes, paths, ports and invalid bind hosts", () => {
    expect(() =>
      readServerEnv({
        APP_AUTH_URL: "http://app.localhost:3001",
        APP_HOST: "https://app.localhost/path",
        APP_WEB_URL: "http://app.localhost:3000",
        AUTH_STATE_SECRET: "test-state-signing-secret-with-enough-length",
        MCP_TOKEN_HASH_SECRET: "test-mcp-token-hash-secret-with-enough-length",
        PASSWORD_MANAGEMENT_ENCRYPTION_KEY: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
        PASSWORD_RESULT_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        DEMO_AUTH_URL: "http://demo.localhost:3001",
        DEMO_HOST: "demo.localhost:3001",
        DEMO_WEB_URL: "http://demo.localhost:3001",
        ...infrastructureEnvironment,
        SERVER_HOST: "not a bind address",
        SERVER_PORT: "3001",
      }),
    ).toThrowError(/APP_HOST, DEMO_HOST, SERVER_HOST/);

    expect(
      readWorkerEnv({
        ...infrastructureEnvironment,
        WORKER_HOST: "::",
        WORKER_PORT: "3002",
      }).WORKER_HOST,
    ).toBe("::");
  });
});
