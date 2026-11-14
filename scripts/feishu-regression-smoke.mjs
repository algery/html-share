import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import {
  startManagementWeb,
  waitForManagementWeb,
  stopProcess,
} from "./password-management-web-harness.mjs";
import assert from "node:assert/strict";

const webUrl = "http://127.0.0.1:55500";
const web = startManagementWeb({
  appUrl: "http://127.0.0.1:55100",
  demoUrl: "http://localhost:55100",
  webUrl,
});
try {
  await waitForManagementWeb(webUrl, assert);
  const live = new Set([
    "local-auth.spec.ts",
    "password-access.spec.ts",
    "session-handoff.spec.ts",
  ]);
  const specs = (await readdir("tests/browser")).filter(
    (name) => name.endsWith(".spec.ts") && !live.has(name),
  );
  const child = spawn(
    process.execPath,
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      ...specs.map((name) => `tests/browser/${name}`),
      "--workers=2",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        HTML_SHARE_DETAIL_WEB_URL: webUrl,
        HTML_SHARE_INSTALL_WEB_URL: webUrl,
        HTML_SHARE_SQUARE_WEB_URL: webUrl,
        HTML_SHARE_TOKEN_WEB_URL: webUrl,
      },
    },
  );
  const status = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(status, 0, "Existing browser regression passes");
} finally {
  await stopProcess(web);
}
