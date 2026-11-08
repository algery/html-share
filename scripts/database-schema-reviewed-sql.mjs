import { createHash } from "node:crypto";

// Reviewed against the current logical schemas and deployed on isolated
// PostgreSQL 18 / MySQL 8.4. SQL is not a regular-expression language: a model
// comparison cannot certify every possible migration statement. Any change to
// these reviewed migration streams must fail until independently reviewed and
// verified against real databases. Do not regenerate these values automatically.
const REVIEWED_MIGRATIONS = {
  postgresql: "d9d2ab0b0c02dbc348fcdd6d418ac27cbf67cd71b87532ece92859d7682858e4",
  mysql: "e775faf0d46f910bace4e46de47725e9d57a27b0a456756a70fa4fe0f50b158a",
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
