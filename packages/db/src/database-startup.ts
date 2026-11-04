import type { DatabaseEnvironment } from "@html-share/config";
import { createDatabaseClient } from "./database-client.js";
import {
  joinDatabaseDeployment,
  invalidateDatabaseDeploymentReceipt,
  type DatabaseDeploymentBarrier,
} from "./database-deployment-barrier.js";
import { DatabaseOperationError } from "./database-errors.js";
import { readRequiredDatabaseMigrations } from "./database-migrations.js";
import { assertSameDatabaseDeployment, checkDatabaseReadiness } from "./database-readiness.js";
import { createDatabaseRepositories } from "./database-repositories.js";

export async function openDatabaseRepositories(
  environment: DatabaseEnvironment,
  options: NonNullable<Parameters<typeof createDatabaseRepositories>[1]> = {},
  deployment?: DatabaseDeploymentBarrier,
) {
  if (deployment) await invalidateDatabaseDeploymentReceipt(deployment);
  const connection = createDatabaseClient(environment);
  try {
    const required = await readRequiredDatabaseMigrations(connection.provider);
    const identity = await checkDatabaseReadiness(connection, required);
    const checkDeployment = deployment
      ? await joinDatabaseDeployment(identity, deployment)
      : undefined;
    return {
      ...createDatabaseRepositories(connection, options),
      readiness: async () => {
        await checkDeployment?.();
        assertSameDatabaseDeployment([
          identity,
          await checkDatabaseReadiness(connection, required),
        ]);
      },
      close: () => connection.client.$disconnect(),
    };
  } catch {
    await connection.client.$disconnect().catch(() => undefined);
    throw new DatabaseOperationError("startup");
  }
}
