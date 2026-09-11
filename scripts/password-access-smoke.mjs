import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHarness, isolatedConfiguration } from "./password-smoke-support.mjs";
import { startPasswordHttps } from "./password-https-harness.mjs";
import {
  publishAccessFixture,
  responseCookies,
  responseState,
} from "./password-access-fixture.mjs";
let assertions = 0;
const check = (value, message) => {
  assert(value, message);
  assertions++;
};
const h = await createHarness(isolatedConfiguration(), check, {
  passwordAccess: true,
  demoUrl: "https://localhost:55443",
});
let https;
try {
  https = await startPasswordHttps();
  const first = await publishAccessFixture(h, check);
  const other = await publishAccessFixture(h, check);
  const publication = h.publicationMetrics();
  check(
    publication.server.getObjectCalls === 0 && publication.worker.getObjectCalls === 0,
    "publication reads zero object bodies",
  );
  const initialUsers = await h.prisma.user.count({ where: { tenantId: h.tenantId } });
  for (const method of ["GET", "HEAD"]) {
    const response = await https.request(first.targetPath, {
      method,
      headers: { "if-none-match": "*" },
    });
    check(response.status === 302, "anonymous GET/HEAD requires password");
    check(response.headers.location.startsWith("/auth/password?"), "anonymous password entry");
    check(
      response.body.length === 0 && !response.headers.etag,
      "anonymous response contains no content/ETag",
    );
  }
  async function login(targetPath, password) {
    const page = await https.request(
      `/auth/password?return_path=${encodeURIComponent(targetPath)}`,
    );
    check(
      page.status === 200 && page.headers["cache-control"] === "no-store",
      "HTTPS password page served",
    );
    return https.request("/auth/password/verify", {
      method: "POST",
      headers: {
        origin: "https://localhost:55443",
        "content-type": "application/json",
        cookie: responseCookies(page),
      },
      body: JSON.stringify({ state: responseState(page), password }),
    });
  }
  const wrong = await login(first.targetPath, "Invalid8");
  check(wrong.status === 401, "wrong password denied");
  const logged = await login(first.targetPath, first.result.access_password);
  check(logged.status === 200, "real password grants project access");
  check(
    JSON.parse(logged.body).redirectUrl === first.targetPath,
    "query and encoded path preserved",
  );
  const cookie = responseCookies(logged);
  const rawCookie = logged.headers["set-cookie"].join(";");
  check(
    ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"].every((flag) => rawCookie.includes(flag)) &&
      !rawCookie.includes("Domain="),
    "host-only secure project cookie",
  );
  check(
    (await h.prisma.user.count({ where: { tenantId: h.tenantId } })) === initialUsers,
    "password does not create organization user",
  );
  for (const [path, body] of first.bodies) {
    const url = `/${first.result.project_id}/${path.split("/").map(encodeURIComponent).join("/")}`;
    const read = await https.request(url, { headers: { cookie } });
    check(read.status === 200 && read.body.equals(body), "HTTPS HTML/CSS/JS/image bytes match");
    check(
      read.headers["cache-control"] === "private, max-age=0, must-revalidate",
      "protected cache revalidates",
    );
    const cached = await https.request(url, {
      headers: { cookie, "if-none-match": read.headers.etag },
    });
    check(cached.status === 304 && cached.body.length === 0, "authorized conditional read");
  }
  const cross = await https.request(other.targetPath, { headers: { cookie } });
  check(cross.status === 302, "grant cannot read another password project");
  for (const path of ["/api/projects", "/mcp"])
    check(
      (await https.request(path, { headers: { cookie } })).status === 404,
      "content host keeps management isolated",
    );
  if (process.argv.includes("--browser")) {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "node_modules/@playwright/test/cli.js",
          "test",
          "tests/browser/password-access.spec.ts",
          "--workers=1",
        ],
        {
          env: {
            ...process.env,
            PASSWORD_BROWSER_DEMO_URL: "https://localhost:55443",
            PASSWORD_BROWSER_TARGET_PATH: first.targetPath,
            PASSWORD_BROWSER_PASSWORD: first.result.access_password,
            PASSWORD_BROWSER_OTHER_PATH: other.targetPath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let logs = "";
      child.stdout.on("data", (data) => (logs += data));
      child.stderr.on("data", (data) => (logs += data));
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code, logs }));
    });
    console.log(
      output.logs
        .replaceAll(first.result.access_password, "[REDACTED]")
        .replaceAll(other.result.access_password, "[REDACTED]"),
    );
    check(output.code === 0, "Chromium/WebKit password browser matrix");
  }
  const inherited = await publishAccessFixture(h, check, {
    action: "replace",
    project_id: first.result.project_id,
  });
  check(
    inherited.result.password_status === "retained",
    "explicit repeated password mode retains password",
  );
  check(
    (await https.request(first.targetPath, { headers: { cookie } })).status === 200,
    "retained password grant reads replacement",
  );
  const reset = await publishAccessFixture(h, check, {
    action: "replace",
    project_id: first.result.project_id,
    regenerate_password: true,
  });
  check(
    reset.result.access_password !== first.result.access_password,
    "explicit reset changes generated password",
  );
  check(
    (
      await https.request(first.targetPath, {
        method: "HEAD",
        headers: { cookie, "if-none-match": "*" },
      })
    ).status === 302,
    "reset invalidates old conditional HEAD grant",
  );
  check(
    (await login(first.targetPath, first.result.access_password)).status === 401,
    "reset rejects old password",
  );
  const resetGrant = await login(first.targetPath, reset.result.access_password);
  check(resetGrant.status === 200, "new password works");
  const resetCookie = responseCookies(resetGrant);
  const project = await h.prisma.demoProject.findUniqueOrThrow({
    where: { projectKey: first.result.project_id },
  });
  await h.prisma.passwordAccessGrant.updateMany({
    where: { projectId: project.id },
    data: { expiresAt: new Date(Date.now() - 1) },
  });
  check(
    (await https.request(first.targetPath, { headers: { cookie: resetCookie } })).status === 302,
    "database expiry immediately rejects existing cookie",
  );
  const disabled = await publishAccessFixture(h, check, {
    action: "replace",
    project_id: first.result.project_id,
    access_mode: "organization",
  });
  check(disabled.result.access_mode === "organization", "password disabled atomically");
  const organization = await https.request(first.targetPath, { headers: { cookie: resetCookie } });
  check(
    organization.status === 302 && organization.headers.location.startsWith("/auth/content-login?"),
    "disabled project requires organization authorization",
  );
  check(
    (await h.prisma.passwordAccessGrant.count({
      where: { projectId: project.id, revokedAt: null },
    })) === 0,
    "disable revokes all stored grants",
  );
  console.log(
    JSON.stringify({
      status: "password-access-smoke-ok",
      assertions,
      publication,
      realHttps: true,
      browser: process.argv.includes("--browser") ? "passed" : "not-requested",
      worker: h.publicationMetrics().worker,
    }),
  );
} finally {
  if (https) await https.close();
  await h.cleanup();
}
