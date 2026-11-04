import { expect, it } from "vitest";
import { readDatabaseEnv } from "./database-environment.js";

const environment = { DATABASE_URL: "postgresql://user:secret@localhost/db" };
it("retains an explicitly configured internal deployment approval path", () => {
  expect(
    readDatabaseEnv({
      ...environment,
      DATABASE_DEPLOYMENT_TARGET_FILE: "/deployment-target/target.json",
    }).DATABASE_DEPLOYMENT_TARGET_FILE,
  ).toBe("/deployment-target/target.json");
  expect(readDatabaseEnv(environment).DATABASE_DEPLOYMENT_TARGET_FILE).toBeUndefined();
});
it.each(["", "relative/target.json", "/directory/invalid\0file"])(
  "rejects an invalid deployment target path safely %#",
  (path) => {
    expect(() =>
      readDatabaseEnv({ ...environment, DATABASE_DEPLOYMENT_TARGET_FILE: path }),
    ).toThrow("Invalid environment variables: DATABASE_DEPLOYMENT_TARGET_FILE");
  },
);
