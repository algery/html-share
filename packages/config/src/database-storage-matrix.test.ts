import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";

import { readServerEnv, readWorkerEnv } from "./environment.js";

const example = parseEnv(readFileSync(new URL("../../../.env.example", import.meta.url), "utf8"));

describe("independent database and production object-storage configuration", () => {
  for (const databaseProvider of ["postgresql", "mysql"] as const) {
    for (const storageProvider of ["oss", "r2"] as const) {
      it(`accepts ${databaseProvider} with ${storageProvider} without changing either target`, () => {
        const databaseUrl = `${databaseProvider}://fixture:local@database.example.com/fixture`;
        const endpoint =
          storageProvider === "r2"
            ? "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"
            : "https://oss-cn-hangzhou.aliyuncs.com";
        const environment = {
          ...example,
          DATABASE_PROVIDER: databaseProvider,
          DATABASE_URL: databaseUrl,
          OBJECT_STORAGE_PROVIDER: storageProvider,
          OBJECT_STORAGE_ENDPOINT: endpoint,
          OBJECT_STORAGE_PUBLIC_ENDPOINT: endpoint,
          OBJECT_STORAGE_REGION: storageProvider === "r2" ? "auto" : "oss-cn-hangzhou",
        };
        const expected = {
          DATABASE_PROVIDER: databaseProvider,
          DATABASE_URL: databaseUrl,
          OBJECT_STORAGE_PROVIDER: storageProvider,
          OBJECT_STORAGE_ENDPOINT: endpoint,
          OBJECT_STORAGE_PUBLIC_ENDPOINT: endpoint,
          OBJECT_STORAGE_BUCKET: example["OBJECT_STORAGE_BUCKET"],
        };
        expect(readServerEnv(environment)).toMatchObject(expected);
        expect(readWorkerEnv(environment)).toMatchObject(expected);
      });
    }
  }
});
