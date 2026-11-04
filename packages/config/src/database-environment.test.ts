import { describe, expect, it } from "vitest";

import { EnvironmentValidationError, readDatabaseEnv } from "./database-environment.js";
import { readServerEnv, readWebEnv, readWorkerEnv } from "./environment.js";

const infrastructure = {
  OBJECT_STORAGE_ACCESS_KEY_ID: "local-access-key",
  OBJECT_STORAGE_ACCESS_KEY_SECRET: "local-secret",
  OBJECT_STORAGE_BUCKET: "html-share-local",
  OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
  OBJECT_STORAGE_PROVIDER: "minio",
  OBJECT_STORAGE_REGION: "local",
};
const worker = { ...infrastructure, WORKER_HOST: "127.0.0.1", WORKER_PORT: "3002" };
const server = {
  ...infrastructure,
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
};

describe("database environment", () => {
  it.each(["postgresql", "postgres"])(
    "keeps legacy %s URLs and TLS options unchanged",
    (scheme) => {
      const DATABASE_URL = `${scheme}://user:p%40ss@localhost:5432/app?schema=public&sslmode=verify-full&sslrootcert=%2Fcerts%2Fca.pem`;
      expect(readDatabaseEnv({ DATABASE_URL })).toEqual({
        DATABASE_PROVIDER: "postgresql",
        DATABASE_URL,
      });
      expect(readDatabaseEnv({ DATABASE_PROVIDER: "postgresql", DATABASE_URL })).toEqual({
        DATABASE_PROVIDER: "postgresql",
        DATABASE_URL,
      });
    },
  );

  it("preserves MySQL connection security options", () => {
    const DATABASE_URL =
      "mysql://user:p%40ss@localhost:3306/app?sslaccept=strict&sslcert=%2Fcerts%2Fca.pem";
    expect(readDatabaseEnv({ DATABASE_PROVIDER: "mysql", DATABASE_URL })).toEqual({
      DATABASE_PROVIDER: "mysql",
      DATABASE_URL,
    });
  });

  it("keeps PostgreSQL socket host connection parameters", () => {
    const DATABASE_URL = "postgresql:///app?host=%2Fvar%2Frun%2Fpostgresql&sslmode=require";
    expect(readDatabaseEnv({ DATABASE_URL }).DATABASE_URL).toBe(DATABASE_URL);
  });

  it.each(["", " ", "postgres", "MYSQL", "sqlite", "postgresql "])(
    "rejects explicitly invalid provider %j",
    (DATABASE_PROVIDER) => {
      expect(() =>
        readDatabaseEnv({
          DATABASE_PROVIDER,
          DATABASE_URL: "postgresql://user:secret@localhost/app",
        }),
      ).toThrowError("Invalid environment variables: DATABASE_PROVIDER");
    },
  );

  it.each([
    { DATABASE_PROVIDER: "postgresql", DATABASE_URL: "mysql://user:secret@localhost/app" },
    { DATABASE_PROVIDER: "mysql", DATABASE_URL: "postgresql://user:secret@localhost/app" },
    { DATABASE_PROVIDER: "mysql", DATABASE_URL: "postgres://user:secret@localhost/app" },
    { DATABASE_URL: "mysql://user:secret@localhost/app" },
    { DATABASE_URL: "https://user:secret@localhost/app" },
    { DATABASE_URL: "postgresql:" },
    { DATABASE_URL: "postgresql://" },
    { DATABASE_PROVIDER: "mysql", DATABASE_URL: "mysql:///app" },
    { DATABASE_URL: "not-a-url" },
    { DATABASE_URL: "" },
    { DATABASE_URL: "   " },
    {},
  ])("rejects absent, malformed and mismatched URLs without credential leakage", (environment) => {
    let failure: unknown;
    try {
      readDatabaseEnv(environment);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(EnvironmentValidationError);
    expect(String(failure)).toBe(
      "EnvironmentValidationError: Invalid environment variables: DATABASE_URL",
    );
    expect(JSON.stringify(failure)).not.toContain("secret");
  });

  it("aggregates provider and URL errors", () => {
    expect(() => readDatabaseEnv({ DATABASE_PROVIDER: "" })).toThrowError(
      "Invalid environment variables: DATABASE_PROVIDER, DATABASE_URL",
    );
  });

  it.each(["postgresql", "mysql"])(
    "shares %s parsing across Server and Worker",
    (DATABASE_PROVIDER) => {
      const DATABASE_URL = `${DATABASE_PROVIDER}://user:secret@localhost/app?connect_timeout=5`;
      const expected = readDatabaseEnv({ DATABASE_PROVIDER, DATABASE_URL });
      expect(readServerEnv({ ...server, DATABASE_PROVIDER, DATABASE_URL })).toMatchObject(expected);
      expect(readWorkerEnv({ ...worker, DATABASE_PROVIDER, DATABASE_URL })).toMatchObject(expected);
    },
  );

  it("keeps all missing service variables in the same validation error", () => {
    for (const read of [readServerEnv, readWorkerEnv]) {
      let failure: unknown;
      try {
        read({ DATABASE_PROVIDER: "" });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(EnvironmentValidationError);
      if (!(failure instanceof EnvironmentValidationError))
        throw new Error("Expected environment failure");
      expect(failure.variables).toEqual(
        expect.arrayContaining([
          "DATABASE_PROVIDER",
          "DATABASE_URL",
          "OBJECT_STORAGE_ACCESS_KEY_ID",
          "OBJECT_STORAGE_PROVIDER",
        ]),
      );
    }
  });

  it("does not expose database configuration through the browser reader", () => {
    expect(
      readWebEnv({
        DATABASE_PROVIDER: "mysql",
        DATABASE_URL: "mysql://user:secret@localhost/app",
        NEXT_PUBLIC_API_URL: "http://app.localhost:3001",
        NEXT_PUBLIC_APP_URL: "http://app.localhost:3000",
        NEXT_PUBLIC_DEMO_URL: "http://demo.localhost:3001",
      }),
    ).toEqual({
      NEXT_PUBLIC_API_URL: "http://app.localhost:3001",
      NEXT_PUBLIC_APP_URL: "http://app.localhost:3000",
      NEXT_PUBLIC_DEMO_URL: "http://demo.localhost:3001",
    });
  });
});
