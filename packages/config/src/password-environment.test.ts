import { describe, expect, it } from "vitest";
import { readServerEnv } from "./environment.js";
const environment = {
  APP_AUTH_URL: "https://app.example.test",
  APP_HOST: "app.example.test",
  APP_WEB_URL: "https://app.example.test",
  DEMO_AUTH_URL: "https://demo.example.test",
  DEMO_HOST: "demo.example.test",
  DEMO_WEB_URL: "https://demo.example.test",
  AUTH_STATE_SECRET: "isolated-state-signing-secret-with-32-characters",
  MCP_TOKEN_HASH_SECRET: "isolated-token-hash-secret-with-32-characters",
  PASSWORD_MANAGEMENT_ENCRYPTION_KEY: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
  PASSWORD_RESULT_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  DATABASE_URL: "postgresql://example:example@localhost:55432/html_share_password",
  OBJECT_STORAGE_ENDPOINT: "http://localhost:59000",
  OBJECT_STORAGE_PROVIDER: "minio",
  OBJECT_STORAGE_REGION: "us-east-1",
  OBJECT_STORAGE_BUCKET: "example",
  OBJECT_STORAGE_ACCESS_KEY_ID: "example",
  OBJECT_STORAGE_ACCESS_KEY_SECRET: "example",
  SERVER_HOST: "127.0.0.1",
  SERVER_PORT: "55100",
};
describe("password verification environment", () => {
  it("accepts documented names and keeps three independent defaults", () => {
    expect(readServerEnv(environment)).toMatchObject({
      PASSWORD_VERIFY_IP_RATE_LIMIT_PER_MINUTE: 60,
      PASSWORD_VERIFY_IP_PROJECT_RATE_LIMIT_PER_MINUTE: 30,
      PASSWORD_VERIFY_PROJECT_RATE_LIMIT_PER_MINUTE: 120,
    });
    expect(
      readServerEnv({
        ...environment,
        PASSWORD_VERIFY_IP_RATE_LIMIT_PER_MINUTE: "7",
        PASSWORD_VERIFY_IP_PROJECT_RATE_LIMIT_PER_MINUTE: "8",
        PASSWORD_VERIFY_PROJECT_RATE_LIMIT_PER_MINUTE: "9",
      }),
    ).toMatchObject({
      PASSWORD_VERIFY_IP_RATE_LIMIT_PER_MINUTE: 7,
      PASSWORD_VERIFY_IP_PROJECT_RATE_LIMIT_PER_MINUTE: 8,
      PASSWORD_VERIFY_PROJECT_RATE_LIMIT_PER_MINUTE: 9,
    });
  });
  it.each(["0", "100001", "x"])("rejects invalid password limit %s", (value) => {
    expect(() =>
      readServerEnv({ ...environment, PASSWORD_VERIFY_IP_RATE_LIMIT_PER_MINUTE: value }),
    ).toThrow("PASSWORD_VERIFY_IP_RATE_LIMIT_PER_MINUTE");
  });

  it("requires a distinct project password management key", () => {
    expect(() =>
      readServerEnv({ ...environment, PASSWORD_MANAGEMENT_ENCRYPTION_KEY: undefined }),
    ).toThrow("PASSWORD_MANAGEMENT_ENCRYPTION_KEY");
    expect(() =>
      readServerEnv({
        ...environment,
        PASSWORD_MANAGEMENT_ENCRYPTION_KEY: environment.PASSWORD_RESULT_ENCRYPTION_KEY,
      }),
    ).toThrow("PASSWORD_MANAGEMENT_ENCRYPTION_KEY");
  });
});
