import { describe, expect, it } from "vitest";

import { readServerEnv } from "./environment.js";

describe("browser environment validation", () => {
  const base = {
    APP_AUTH_URL: "https://app.example.test",
    APP_HOST: "app.example.test",
    APP_WEB_URL: "https://app.example.test",
    AUTH_STATE_SECRET: "test-state-signing-secret-with-enough-length",
    MCP_TOKEN_HASH_SECRET: "test-mcp-token-hash-secret-with-enough-length",
    PASSWORD_MANAGEMENT_ENCRYPTION_KEY: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
    PASSWORD_RESULT_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
    DEMO_AUTH_URL: "https://demo.example.test",
    DEMO_HOST: "demo.example.test",
    DEMO_WEB_URL: "https://demo.example.test",
    DATABASE_URL: "postgresql://html_share:local@127.0.0.1:5432/html_share",
    OBJECT_STORAGE_ACCESS_KEY_ID: "local-access-key",
    OBJECT_STORAGE_ACCESS_KEY_SECRET: "local-secret",
    OBJECT_STORAGE_BUCKET: "html-share-local",
    OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
    OBJECT_STORAGE_PROVIDER: "minio",
    OBJECT_STORAGE_REGION: "local",
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: "3001",
  } as const;

  it("requires HTTPS outside local development and keeps URLs on configured hosts", () => {
    expect(() => readServerEnv({ ...base, DEMO_AUTH_URL: "http://demo.example.test" })).toThrow(
      /DEMO_AUTH_URL/,
    );
    expect(() => readServerEnv({ ...base, APP_AUTH_URL: "https://other.example.test" })).toThrow(
      /APP_AUTH_URL/,
    );
    for (const hostname of ["127.attacker.test", "127.0.0.1.attacker.test"]) {
      expect(() =>
        readServerEnv({
          ...base,
          APP_AUTH_URL: `http://${hostname}`,
          APP_HOST: hostname,
          APP_WEB_URL: `http://${hostname}`,
        }),
      ).toThrow(/APP_AUTH_URL, APP_WEB_URL/);
    }
    expect(() =>
      readServerEnv({
        ...base,
        APP_AUTH_URL: "http://127.0.0.1:3001",
        APP_HOST: "127.0.0.1",
        APP_WEB_URL: "http://127.0.0.1:3000",
      }),
    ).not.toThrow();
    const ipv6Environment = readServerEnv({
      ...base,
      APP_AUTH_URL: "http://[::1]:3001",
      APP_HOST: "::1",
      APP_WEB_URL: "http://[::1]:3000",
    });
    expect(ipv6Environment.APP_HOST).toBe("[::1]");
    expect(() =>
      readServerEnv({
        ...base,
        APP_AUTH_URL: "HTTPS://app.example.test",
        APP_WEB_URL: "HTTPS://app.example.test",
      }),
    ).not.toThrow();
    expect(() =>
      readServerEnv({
        ...base,
        APP_AUTH_URL: "http://[::1]@attacker.test:3001",
        APP_HOST: "::1",
        APP_WEB_URL: "http://[::1]:3000",
      }),
    ).toThrow(/APP_AUTH_URL/);
  });
});
