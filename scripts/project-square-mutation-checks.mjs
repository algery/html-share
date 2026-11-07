import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { fixture } from "./password-smoke-fixture.mjs";
const requireServer = createRequire(new URL("../apps/server/package.json", import.meta.url));
const { Client, StreamableHTTPClientTransport } = await import(
  pathToFileURL(requireServer.resolve("@modelcontextprotocol/client")).href
);

export async function assertSquareViewerCannotMutate({ h, api, cookie, csrf, key, check }) {
  const before = await h.prisma.demoProject.findUniqueOrThrow({ where: { projectKey: key } });
  check(
    (
      await api(
        `/api/projects/${key}/password-access`,
        cookie,
        { action: "regenerate" },
        csrf,
        "POST",
      )
    ).status === 404,
    "in-range visitor cannot read or regenerate project password",
  );
  check(
    (await api(`/api/projects/${key}/delete`, cookie, { confirmation: key }, csrf, "POST"))
      .status === 403,
    "in-range visitor cannot delete project",
  );
  const token = await api(
    "/api/tokens",
    cookie,
    { name: "Square viewer authorization check" },
    csrf,
    "POST",
  );
  check(token.status === 201, "viewer can create their own token");
  const client = new Client({ name: "square-permission-check", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(h.mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${token.body.value}` } },
      }),
    );
    await h.call(
      "prepare_demo_upload",
      fixture("denied-viewer", { action: "replace", project_id: key }).args,
      "project_forbidden",
      client,
    );
  } finally {
    await client.close();
  }
  const after = await h.prisma.demoProject.findUniqueOrThrow({ where: { projectKey: key } });
  check(
    after.currentRevisionId === before.currentRevisionId &&
      after.passwordVersion === before.passwordVersion &&
      after.status === before.status,
    "denied visitor actions leave current revision, password and project unchanged",
  );
}
