import { createHash } from "node:crypto";

// Reviewed against the current logical schemas and deployed on isolated
// PostgreSQL 18 / MySQL 8.4. SQL is not a regular-expression language: a model
// comparison cannot certify every possible migration statement. Any change to
// these reviewed migration streams must fail until independently reviewed and
// verified against real databases. Do not regenerate these values automatically.
const REVIEWED_MIGRATIONS = {
  postgresql: "fbbaa424f6b061c8edc5138777dc00f5cec5861c09e0c0265c38a4e6d497a26c",
  mysql: "0fa2149eec76b770589a002ef70dc5f3253e0fdb019a4b3234e6d328220bee1e",
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
