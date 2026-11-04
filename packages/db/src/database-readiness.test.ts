import { describe, expect, it, vi } from "vitest";

import type { DatabaseConnection } from "./database-client.js";
import { readRequiredDatabaseMigrations } from "./database-migrations.js";
import { assertSameDatabaseDeployment, checkDatabaseReadiness } from "./database-readiness.js";

const required = [{ name: "migration_one", checksum: "a".repeat(64) }];
const instanceId = "12345678-1234-1234-1234-123456789abc";
const actualTarget = [
  { database_name: "fixture", schema_name: "public", server_instance: "actual-server-one" },
];
const applied = {
  migration_name: required[0]?.name,
  checksum: required[0]?.checksum,
  finished_at: new Date(),
  rolled_back_at: null,
};

function fixture(provider: DatabaseConnection["provider"] = "postgresql") {
  const query = vi.fn().mockResolvedValueOnce(actualTarget).mockResolvedValueOnce([applied]);
  const identity = vi.fn().mockResolvedValue({ instanceId });
  const connect = vi.fn().mockResolvedValue(undefined);
  const db = {
    provider,
    client: { $connect: connect, $queryRaw: query, databaseIdentity: { findUnique: identity } },
  };
  return { connection: db as unknown as DatabaseConnection, query, identity, connect };
}

describe.each(["postgresql", "mysql"] as const)("%s database readiness", (provider) => {
  it("checks actual SQL, checksum and pre-existing identity without writes", async () => {
    const { connection, query, identity } = fixture(provider);
    const result = await checkDatabaseReadiness(connection, required);
    expect(result).toMatchObject({ provider, instanceId });
    expect(result.schemaVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(query).toHaveBeenCalledTimes(2);
    expect(identity).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it("distinguishes same-named clones with copied database UUID using actual engine identity", async () => {
    const original = fixture(provider);
    const clone = fixture(provider);
    clone.query
      .mockReset()
      .mockResolvedValueOnce([{ ...actualTarget[0], server_instance: "actual-server-two" }])
      .mockResolvedValueOnce([applied]);
    const identities = await Promise.all(
      [original, clone].map((test) => checkDatabaseReadiness(test.connection, required)),
    );
    expect(identities[0]?.instanceId).toBe(identities[1]?.instanceId);
    expect(identities[0]?.logicalTarget).not.toBe(identities[1]?.logicalTarget);
    expect(() => assertSameDatabaseDeployment(identities)).toThrow("Database deployment mismatch");
  });

  it("rejects a successful connect with a failed SQL round trip safely", async () => {
    const { connection, query, identity } = fixture(provider);
    query.mockReset().mockRejectedValue(new Error("mysql://private:password@private-host/db"));
    const result = checkDatabaseReadiness(connection, required);
    await expect(result).rejects.toMatchObject({ reason: "connection" });
    await expect(result).rejects.not.toThrow("private");
    expect(identity).not.toHaveBeenCalled();
  });

  it.each(
    [
      [],
      [{ ...applied, checksum: "b".repeat(64) }],
      [{ ...applied, finished_at: null }],
      [{ ...applied, rolled_back_at: new Date() }],
      [applied, applied],
      [applied, { ...applied, migration_name: "pending", finished_at: null }],
    ].map((rows) => ({ rows })),
  )("rejects missing, changed, rolled back or unfinished schema %#", async ({ rows }) => {
    const { connection, query, identity } = fixture(provider);
    query.mockReset().mockResolvedValueOnce(actualTarget).mockResolvedValueOnce(rows);
    await expect(checkDatabaseReadiness(connection, required)).rejects.toMatchObject({
      reason: "migration",
    });
    expect(identity).not.toHaveBeenCalled();
  });

  it("ignores explicitly rolled-back failures if the delivered history succeeded", async () => {
    const { connection, query } = fixture(provider);
    query
      .mockReset()
      .mockResolvedValueOnce(actualTarget)
      .mockResolvedValueOnce([
        applied,
        { ...applied, finished_at: null, rolled_back_at: new Date() },
      ]);
    await expect(checkDatabaseReadiness(connection, required)).resolves.toMatchObject({
      instanceId,
    });
  });

  it.each([null, { instanceId: "invalid" }])(
    "rejects absent or invalid identity without generating it",
    async (value) => {
      const { connection, identity } = fixture(provider);
      identity.mockResolvedValue(value);
      await expect(checkDatabaseReadiness(connection, required)).rejects.toMatchObject({
        reason: "identity",
      });
    },
  );

  it("reads checksums from the delivered provider-specific migration files", async () => {
    const migrations = await readRequiredDatabaseMigrations(provider);
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations.every((row) => /^[a-f0-9]{64}$/.test(row.checksum))).toBe(true);
    expect(
      migrations.some((row) =>
        row.name.includes(provider === "mysql" ? "mysql_initial" : "database_identity"),
      ),
    ).toBe(true);
  });
});

it("compares actual provider/schema/instance identity without using URL text", () => {
  const identity = {
    provider: "postgresql",
    instanceId,
    schemaVersion: "v1",
    logicalTarget: "logical1",
  } as const;
  expect(() => assertSameDatabaseDeployment([identity, { ...identity }])).not.toThrow();
  for (const other of [
    { ...identity, provider: "mysql" as const },
    { ...identity, schemaVersion: "v2" },
    { ...identity, logicalTarget: "logical2" },
    { ...identity, instanceId: "private-identity" },
  ]) {
    expect(() => assertSameDatabaseDeployment([identity, other])).toThrow(
      "Database deployment mismatch",
    );
    expect(() => assertSameDatabaseDeployment([identity, other])).not.toThrow("private-identity");
  }
});
