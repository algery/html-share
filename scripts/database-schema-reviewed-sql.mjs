import { createHash } from "node:crypto";

// Reviewed against the current logical schemas and deployed on isolated
// PostgreSQL 18 / MySQL 8.4. SQL is not a regular-expression language: a model
// comparison cannot certify every possible migration statement. Any change to
// these reviewed migration streams must fail until independently reviewed and
// verified against real databases. Do not regenerate these values automatically.
const REVIEWED_MIGRATIONS = {
  postgresql: "fba08ebd85ac7e03a237e0b5642a94d205b18c18b182238040215c98c2fd6208",
  mysql: "b83bca1dcb86b1717a23e49085e517fcd340bdbfb74fcd458141c81a47231514",
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
