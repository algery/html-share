import { createHash } from "node:crypto";

// Reviewed against the current logical schemas and deployed on isolated
// PostgreSQL 18 / MySQL 8.4. SQL is not a regular-expression language: a model
// comparison cannot certify every possible migration statement. Any change to
// these reviewed migration streams must fail until independently reviewed and
// verified against real databases. Do not regenerate these values automatically.
const REVIEWED_MIGRATIONS = {
  postgresql: "fe99b117b2800d2d926d1021fcc5f4f110b985aa2b8b078219476bfd5cbd3f90",
  mysql: "a67fa95880e6f34a5114d63d4c03b108b388b0adf46bfc3d4c47fb6b4945a7c2",
};

export function compareReviewedSql(postgresSql, mysqlSql) {
  return [
    ["postgresql", postgresSql],
    ["mysql", mysqlSql],
  ]
    .filter(
      ([provider, sql]) =>
        createHash("sha256").update(sql).digest("hex") !== REVIEWED_MIGRATIONS[provider],
    )
    .map(
      ([provider]) =>
        `${provider} migration SQL changed; independent review and real database validation are required before updating its reviewed fingerprint`,
    );
}
