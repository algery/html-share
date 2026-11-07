import { assertSquareViewerCannotMutate } from "./project-square-mutation-checks.mjs";
import assert from "node:assert/strict";
import { createDirectoryService, DirectoryUnavailableError } from "../packages/core/dist/index.js";
import { createSimulatorDirectoryProvider } from "../packages/dingtalk/dist/index.js";
import { createHarness, fixture } from "./password-smoke-support.mjs";
import { squareSmokeConfiguration, squareSession } from "./project-square-harness.mjs";
import { responseCookies, responseState } from "./password-access-fixture.mjs";

let assertions = 0;
const check = (value, message) => {
  assert(value, message);
  assertions++;
};
for (const provider of ["postgresql", "mysql"]) {
  let clock = Date.now();
  let failed = false;
  const synthetic = createSimulatorDirectoryProvider();
  const directory = createDirectoryService(
    {
      getSnapshot(input) {
        if (failed) throw new DirectoryUnavailableError();
        return synthetic.getSnapshot(input);
      },
      resolveMember(input) {
        if (failed) throw new DirectoryUnavailableError();
        return synthetic.resolveMember(input);
      },
    },
    { now: () => clock },
  );
  const h = await createHarness(squareSmokeConfiguration(provider), check, {
    passwordAccess: true,
    squareDirectory: directory,
  });
  try {
    const inside = await squareSession(h, "simulator-member-002");
    const outside = await squareSession(h, "simulator-member-003");
    const explicit = await squareSession(h, "simulator-member-005");
    const outsideDemo = await squareSession(h, "simulator-member-003", "demo");
    const api = async (path, cookie = h.appCookie, body, csrf = h.appCsrfToken, method) => {
      const response = await fetch(`http://127.0.0.1:55100${path}`, {
        method: method ?? (body === undefined ? "GET" : "PUT"),
        headers: {
          cookie,
          origin: h.appWebUrl,
          ...(body === undefined
            ? {}
            : { "content-type": "application/json", "x-html-share-csrf": csrf }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000),
      });
      return { status: response.status, headers: response.headers, body: await response.json() };
    };
    async function publish(input) {
      const prepared = await h.call("prepare_demo_upload", input.args);
      for (const upload of prepared.uploads) {
        check(
          (
            await fetch(upload.upload_url, {
              method: "PUT",
              headers: upload.upload_headers,
              body: input.bodies.get(upload.relative_path),
            })
          ).ok,
          "real MinIO upload succeeds",
        );
      }
      await h.call("complete_demo_upload", { upload_id: prepared.upload_id });
      check((await h.finalize()) === "published", "real worker publishes current revision");
      return h.call("get_demo_upload_status", { upload_id: prepared.upload_id });
    }
    const original = fixture("square-initial", {
      display_name: "广场真实闭环",
      access_mode: "password",
    });
    const project = await publish(original);
    const key = project.project_id;
    const settingsPath = `/api/projects/${key}/square`;
    const detailPath = `/api/square/projects/${key}`;
    const list = (cookie) => api("/api/square/projects", cookie);
    check(
      (await api(settingsPath)).body.settings.enabled === false,
      "old/new projects default to off",
    );
    check((await list(inside)).body.total === 0, "unshared metadata is absent");
    const scope = {
      enabled: true,
      audienceType: "selected",
      departmentIds: ["10"],
      userIds: ["simulator-enterprise-user-005"],
      settingsVersion: 0,
    };
    check(
      (await api(settingsPath, h.appCookie, scope)).status === 200,
      "owner publishes mixed audience",
    );
    check(
      (await list(inside)).body.total === 1,
      "child/multiple department membership grants discovery",
    );
    check(
      (await list(explicit)).body.total === 1,
      "explicit person outside selected department grants discovery",
    );
    const fresh = await squareSession(h, "simulator-member-004");
    check(
      (await list(fresh)).body.total === 1,
      "previously unregistered directory member matches first login",
    );
    check((await list(outside)).body.total === 0, "outside viewer sees zero authorized count");
    check(
      (await api("/api/square/projects?q=" + encodeURIComponent("真实"), outside)).body.total === 0,
      "search does not reveal hidden count",
    );
    check((await api(detailPath, outside)).status === 404, "outside detail returns 404");
    const detail = await api(detailPath, inside);
    check(
      detail.status === 200 && detail.body.files.length === 2,
      "separate detail reads current collection",
    );
    check(
      Object.keys(detail.body.project).sort().join() ===
        [
          "projectId",
          "displayName",
          "creatorDisplayName",
          "updatedAt",
          "fileCount",
          "totalSize",
          "homepage",
        ]
          .sort()
          .join(),
      "detail project white list excludes passwords and audience",
    );
    check(
      detail.body.files.every(
        (file) => Object.keys(file).sort().join() === "relativePath,size,url",
      ),
      "file white list excludes storage keys",
    );
    const insideCsrf = (await api("/api/csrf", inside)).body.csrfToken;
    for (const path of [`/api/projects/${key}`, settingsPath])
      check((await api(path, inside)).status === 404, "non-owner management read denied");
    check(
      (await api(settingsPath, inside, scope, insideCsrf)).status === 404,
      "non-owner settings write denied",
    );
    check(
      (
        await api(
          `/api/projects/${key}/homepage`,
          inside,
          { relativePath: "nested/测试 file.html" },
          insideCsrf,
        )
      ).status === 404,
      "non-owner homepage write denied",
    );
    await assertSquareViewerCannotMutate({ h, api, cookie: inside, csrf: insideCsrf, key, check });
    const target = new URL(project.target_url).pathname;
    async function assertLinks() {
      const read = await fetch(h.demoUrl + target, {
        headers: { cookie: outsideDemo },
        redirect: "manual",
      });
      check(read.status === 200, "outside-square organization member can read exact content link");
      const page = await h.app.inject({
        url: `/auth/password?return_path=${encodeURIComponent(target)}`,
        headers: { host: "localhost" },
      });
      const verified = await h.app.inject({
        method: "POST",
        url: "/auth/password/verify",
        headers: { host: "localhost", origin: h.demoUrl, cookie: responseCookies(page) },
        payload: { state: responseState(page), password: project.access_password },
      });
      check(verified.statusCode === 200, "existing password still grants content access");
      check(
        (
          await h.app.inject({
            url: target,
            headers: { host: "localhost", cookie: responseCookies(verified) },
          })
        ).statusCode === 200,
        "password grant reads exact content",
      );
      check(
        (
          await h.app.inject({
            url: "/api/square/projects",
            headers: { host: "127.0.0.1", cookie: responseCookies(verified) },
          })
        ).statusCode === 401,
        "password grant never authorizes square",
      );
    }
    await assertLinks();
    check(
      (await api(settingsPath, h.appCookie, { ...scope, userIds: ["forged"], settingsVersion: 1 }))
        .status === 400,
      "forged IDs rejected atomically",
    );
    check(
      (await api(settingsPath, h.appCookie, { ...scope, settingsVersion: 0 })).status === 409,
      "stale settings version rejected",
    );
    check(
      (
        await api(settingsPath, h.appCookie, {
          ...scope,
          departmentIds: [],
          userIds: ["simulator-enterprise-user-005"],
          settingsVersion: 1,
        })
      ).status === 200,
      "owner shrinks audience",
    );
    check(
      (await list(inside)).body.total === 0 && (await list(explicit)).body.total === 1,
      "scope shrink affects next request without directory cache expiry",
    );
    const replacement = await publish(
      fixture("square-replaced", {
        action: "replace",
        project_id: key,
        display_name: "广场覆盖后",
      }),
    );
    check(replacement.status === "completed", "replacement completes");
    check(
      (await api(settingsPath)).body.settings.settingsVersion === 2,
      "replacement preserves audience settings",
    );
    check(
      (await api(detailPath, explicit)).body.project.displayName === "广场覆盖后",
      "square reads latest successful revision",
    );
    clock += 300001;
    failed = true;
    const closed = await list(explicit);
    check(
      closed.body.total === 0 && closed.body.directoryUnavailable === true,
      "expired failed directory closes selected access",
    );
    check((await list(h.appCookie)).body.total === 1, "owner remains visible when directory fails");
    check(
      (await api(settingsPath, h.appCookie, { enabled: false, settingsVersion: 2 })).status === 200,
      "retract succeeds without directory",
    );
    check((await list(h.appCookie)).body.total === 0, "retract removes owner discovery too");
    await assertLinks();
    check(
      (
        await api(settingsPath, h.appCookie, {
          enabled: true,
          audienceType: "organization",
          settingsVersion: 3,
        })
      ).status === 200,
      "whole organization does not depend on directory",
    );
    check((await list(outside)).body.total === 1, "organization branch survives directory outage");
    const deletion = await api(
      `/api/projects/${key}/delete`,
      h.appCookie,
      { confirmation: key },
      h.appCsrfToken,
      "POST",
    );
    check(deletion.status === 200, "owner deletes project");
    check(
      (await list(outside)).body.total === 0 && (await api(detailPath, outside)).status === 404,
      "deleted project vanishes immediately",
    );
    check(
      (await h.prisma.squareAuditLog.count({ where: { tenantId: h.tenantId } })) >= 7,
      "successful and failed sharing actions are audited",
    );
    check(
      h.publicationMetrics().worker.getObjectCalls === 0,
      "publication worker reads zero object bodies",
    );
    console.log(JSON.stringify({ status: "project-square-smoke-ok", provider, assertions }));
  } finally {
    await h.cleanup();
  }
}
