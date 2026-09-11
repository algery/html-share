import type { FastifyInstance } from "fastify";

export async function createDemoSession(app: FastifyInstance) {
  const started = await app.inject({
    method: "POST",
    url: "/auth/internal/start",
    headers: { host: "demo.localhost" },
    payload: { returnPath: "/abc12/a.html" },
  });
  const completed = await app.inject({
    method: "POST",
    url: "/auth/internal/complete",
    headers: { host: "demo.localhost" },
    payload: { code: "simulator-member", state: started.json<{ state: string }>().state },
  });
  return readCookie(completed);
}

export async function createAppSession(app: FastifyInstance) {
  const started = await app.inject({
    method: "POST",
    url: "/auth/internal/start",
    headers: { host: "app.localhost" },
    payload: { returnPath: "/" },
  });
  const completed = await app.inject({
    method: "POST",
    url: "/auth/internal/complete",
    headers: { host: "app.localhost" },
    payload: { code: "simulator-member", state: started.json<{ state: string }>().state },
  });
  return readCookie(completed);
}

function readCookie(response: { headers: Record<string, unknown> }) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") throw new Error("session cookie missing");
  return value.split(";", 1)[0] ?? "";
}
