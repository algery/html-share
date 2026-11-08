import { expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export async function getTokenWriteHeaders(app: FastifyInstance) {
  const cookie = await createAppSession(app);
  const csrf = await app.inject({
    method: "GET",
    url: "/api/csrf",
    headers: { cookie, host: "app.localhost" },
  });
  expect(csrf.statusCode).toBe(200);
  return {
    cookie,
    host: "app.localhost",
    origin: "http://app.localhost:3000",
    "x-html-share-csrf": csrf.json<{ csrfToken: string }>().csrfToken,
  };
}

async function createAppSession(app: FastifyInstance) {
  const login = await app.inject({
    method: "GET",
    url: "/auth/login",
    headers: { host: "app.localhost" },
  });
  const location = login.headers["location"];
  if (typeof location !== "string") throw new Error("location header missing");
  const callback = new URL(location);
  const completed = await app.inject({
    method: "GET",
    url: `${callback.pathname}${callback.search}`,
    headers: { host: "app.localhost" },
  });
  const header = completed.headers["set-cookie"];
  const cookie = Array.isArray(header) ? header[0] : header;
  if (typeof cookie !== "string") throw new Error("session cookie missing");
  return cookie.split(";")[0] ?? "";
}

export async function checkConnection(endpoint: URL, token: string, clientName: string) {
  const client = new Client({ name: clientName, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  const result = await client.callTool({ arguments: {}, name: "check_connection" });
  await client.close();
  return result;
}
