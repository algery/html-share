import assert from "node:assert/strict";
import { createHarness, isolatedConfiguration } from "./password-smoke-support.mjs";
import {
  publishAccessFixture,
  responseCookies,
  responseState,
} from "./password-access-fixture.mjs";
import { requireProxyImages, startPasswordProxy } from "./password-proxy-runtime.mjs";

// Requires the coordinator's exclusive DB/MinIO/55100/55443 window.
if (!process.argv.includes("--exclusive-window"))
  throw new Error("Exclusive local smoke window must be explicitly acknowledged");
const configuration = isolatedConfiguration();
const selected = process.argv.find((argument) => argument.startsWith("--proxy="))?.slice(8);
const kinds = selected ? [selected] : ["caddy", "openresty"];
await requireProxyImages(kinds);
let assertions = 0;
const check = (condition, message) => {
  assert(condition, message);
  assertions += 1;
};
const h = await createHarness(configuration, check, {
  passwordAccess: true,
  demoUrl: "https://localhost:55443",
});
const results = [];
try {
  const first = await publishAccessFixture(h, check);
  const other = await publishAccessFixture(h, check);
  const publication = h.publicationMetrics();
  check(
    publication.server.getObjectCalls === 0 && publication.worker.getObjectCalls === 0,
    "publication reads zero object bodies",
  );
  for (const kind of kinds) {
    const proxy = await startPasswordProxy(kind);
    try {
      const anonymous = await proxy.request(first.targetPath, {
        method: "HEAD",
        headers: { "if-none-match": "*" },
      });
      check(
        anonymous.status === 302 && anonymous.headers.location.startsWith("/auth/password?"),
        `${kind} anonymous HEAD requires password`,
      );
      check(
        anonymous.body.length === 0 && !anonymous.headers.etag,
        `${kind} anonymous HEAD exposes no object metadata`,
      );
      const page = await proxy.request(anonymous.headers.location);
      check(
        page.status === 200 &&
          page.headers["cache-control"] === "no-store" &&
          page.headers["referrer-policy"] === "no-referrer",
        `${kind} password GET and privacy headers reach the gateway`,
      );
      const headers = {
        origin: "https://localhost:55443",
        "content-type": "application/json",
        cookie: responseCookies(page),
      };
      const body = JSON.stringify({
        state: responseState(page),
        password: first.result.access_password,
      });
      for (const origin of ["null", "https://untrusted.invalid"]) {
        const denied = await proxy.request("/auth/password/verify", {
          method: "POST",
          headers: { ...headers, origin },
          body,
        });
        check(denied.status === 403, `${kind} denies non-site Origin`);
      }
      const granted = await proxy.request("/auth/password/verify", {
        method: "POST",
        headers,
        body,
      });
      check(granted.status === 200, `${kind} HTTPS POST with correct Origin accepts real password`);
      check(
        JSON.parse(granted.body).redirectUrl === first.targetPath,
        `${kind} preserves exact encoded path and query`,
      );
      const cookie = responseCookies(granted);
      const rawCookie = (granted.headers["set-cookie"] ?? []).join(";");
      check(
        ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"].every((value) =>
          rawCookie.includes(value),
        ) && !rawCookie.includes("Domain="),
        `${kind} preserves Host-only secure grant cookie`,
      );
      check(granted.headers["cache-control"] === "no-store", `${kind} never caches password POST`);
      for (const [path, bytes] of first.bodies) {
        const file = `/${first.result.project_id}/${path.split("/").map(encodeURIComponent).join("/")}`;
        const response = await proxy.request(file, { headers: { cookie } });
        check(
          response.status === 200 && response.body.equals(bytes),
          `${kind} serves authorized file bytes unchanged`,
        );
        check(
          response.headers["cache-control"] === "private, max-age=0, must-revalidate",
          `${kind} preserves protected cache policy`,
        );
      }
      check(
        (await proxy.request(other.targetPath, { headers: { cookie } })).status === 302,
        `${kind} grants remain scoped to one project`,
      );
      for (const path of [
        "/api/projects",
        "/api/tokens",
        "/api/admin/projects",
        "/auth/current",
        "/health/metrics",
        "/mcp",
      ]) {
        check(
          (await proxy.request(path, { headers: { cookie } })).status === 404,
          `${kind} content domain denies ${path}`,
        );
      }
      check(
        (
          await proxy.request("/mcp", {
            method: "POST",
            headers: { ...headers, cookie },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
          })
        ).status === 404,
        `${kind} content domain denies MCP POST`,
      );
      // A fail-closed rollback option: stop all application ingress, retain all access fields,
      // then resume the same known password-compatible version and recheck both paths.
      const snapshot = () =>
        h.prisma.demoProject.findUniqueOrThrow({
          where: { projectKey: first.result.project_id },
          select: {
            accessMode: true,
            passwordHash: true,
            passwordVersion: true,
            currentRevisionId: true,
            status: true,
          },
        });
      const before = await snapshot();
      await new Promise((resolve, reject) => {
        h.app.server.close((error) => (error ? reject(error) : resolve()));
        h.app.server.closeAllConnections();
      });
      try {
        const unavailable = await proxy.request(first.targetPath, { headers: { cookie } });
        check(
          [502, 503].includes(unavailable.status) &&
            !unavailable.body.includes("Protected fixture"),
          `${kind} stopped application fails closed during rollback`,
        );
        check(
          JSON.stringify(await snapshot()) === JSON.stringify(before),
          `${kind} rollback never clears project access fields`,
        );
      } finally {
        await new Promise((resolve, reject) => {
          h.app.server.once("error", reject);
          h.app.server.listen(55100, "127.0.0.1", resolve);
        });
      }
      check(
        (await proxy.request(first.targetPath, { headers: { cookie } })).status === 200,
        `${kind} compatible restart preserves valid grant`,
      );
      check(
        (await proxy.request(first.targetPath)).status === 302,
        `${kind} compatible restart still denies anonymous access`,
      );
      await proxy.assertLogsExclude(
        [
          first.result.access_password,
          other.result.access_password,
          cookie.split("=")[1],
          h.mcpToken,
        ],
        check,
      );
      results.push({
        ...proxy.evidence,
        rollback: "stop-service-fail-closed-and-resume-compatible-version",
      });
    } finally {
      await proxy.close();
    }
  }
  console.log(
    JSON.stringify({ status: "password-proxy-smoke-ok", assertions, results, publication }),
  );
} finally {
  await h.cleanup();
}
