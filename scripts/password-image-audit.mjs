import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectContent, inspectFileName, scanRoot } from "./secret-hygiene.mjs";

assert(
  process.platform === "linux" && process.cwd() === "/workspace",
  "image audit runs only inside isolated Linux build",
);
assert(
  (await scanRoot(pathToFileURL("/workspace/"))).length === 0,
  "image source scan contains no non-placeholder credentials",
);
for (const excluded of ["test-results", "playwright-report", ".git", ".env"]) {
  await assert.rejects(stat(join("/workspace", excluded)), { code: "ENOENT" });
}
let files = 0;
for (const root of [
  "apps/server/dist",
  "apps/worker/dist",
  "apps/web/.next/standalone",
  "apps/web/public",
  "packages/core/dist",
  "packages/db/dist",
  "packages/db/src/generated",
])
  await inspect(join("/workspace", root));
console.log(
  JSON.stringify({
    status: "password-image-audit-ok",
    files,
    scope: "application-source-and-selected-compiled-directories-excluding-node-modules",
  }),
);

async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await inspect(path);
    else if (entry.isFile()) {
      files++;
      assert(!inspectFileName(path), "built image contains no secret files");
      const content = await readFile(path, "utf8");
      assert(
        inspectContent(content).length === 0,
        "built output contains no non-placeholder credentials",
      );
      assert(
        !/\/Users\/|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content),
        "built output excludes local paths/private keys",
      );
    }
  }
}
