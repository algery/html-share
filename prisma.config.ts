import { defineConfig } from "prisma/config";

import { readDatabaseEnv } from "./packages/config/src/database-environment.ts";

const environment = readDatabaseEnv(process.env);
const schema = environment.DATABASE_PROVIDER === "mysql" ? "prisma-mysql" : "prisma";

export default defineConfig({
  schema: `packages/db/${schema}`,
  migrations: {
    path: `packages/db/${schema}/migrations`,
  },
  datasource: {
    url: environment.DATABASE_URL,
  },
});
