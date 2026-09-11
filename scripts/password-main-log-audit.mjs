import { writeFile } from "node:fs/promises";

import { noSecretFields } from "./password-main-processes.mjs";

export async function completeMainSmoke({ assertions, check, logs, report, secrets }) {
  check(
    secrets.every(
      (value) => typeof value === "string" && value.length > 0 && !logs.includes(value),
    ),
    "captured real main logs do not contain runtime credentials",
  );
  const records = logs
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  check(records.every(noSecretFields), "main logs contain no sensitive structured fields");
  check(
    records.some((line) => line.action === "upload_finalization" && line.result === "published"),
    "real main publication log observed",
  );
  check(
    records.some((line) => line.action === "password_cleanup" && line.result === "completed"),
    "real main password cleanup log observed",
  );
  check(
    records.some((line) => line.action === "authorization"),
    "real main authorization log observed",
  );
  check(
    !records.some((line) => line.msg === "worker job failed" || line.level >= 50),
    "real mains emit no error records",
  );
  const result = {
    ...report,
    assertions: assertions(),
    runtimeLogRecords: records.length,
    checkedCredentialValues: secrets.length,
    runtimeLogLeakage: false,
    cleanupComplete: true,
  };
  await writeFile(
    "/private/tmp/html-share-phase13-main.log",
    logs + JSON.stringify(result) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(result));
}
