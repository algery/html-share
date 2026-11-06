import { createHash } from "node:crypto";

// Reviewed against the current logical schemas and deployed on isolated
// PostgreSQL 18 / MySQL 8.4. SQL is not a regular-expression language: a model
// comparison cannot certify every possible migration statement. Any change to
// these reviewed migration streams must fail until independently reviewed and
// verified against real databases. Do not regenerate these values automatically.
const REVIEWED_MIGRATIONS = {
  postgresql: "f9fbd1a0c3c559a13344b2df75f5729389f1c2718c8ed9251e8121f9bdecceb6",
  mysql: "c2e37b3605b37ba3a84fc12b65c7f3e4438985f78945e554e6e89db6f7cddc5f",
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
