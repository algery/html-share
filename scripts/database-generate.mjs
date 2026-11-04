import { runPrisma } from "./database-command.mjs";

try {
  for (const provider of ["postgresql", "mysql"]) {
    runPrisma(["generate"], {
      DATABASE_PROVIDER: provider,
      DATABASE_URL: `${provider}://unused:unused@127.0.0.1:1/build_only`,
    });
    console.log(`Generated ${provider} client`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Database client generation failed");
  process.exitCode = 1;
}
