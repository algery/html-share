import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "packages/db/prisma",
  migrations: {
    path: "packages/db/prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
