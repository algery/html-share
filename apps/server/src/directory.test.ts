import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { squareTestApp } from "./square.test-helper.js";
import { createAppSession } from "./phase5-session.test-helper.js";

describe("directory projection and bounded pagination", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });
  async function setup() {
    const fixture = squareTestApp();
    apps.push(fixture.app);
    return {
      ...fixture,
      headers: { host: "app.localhost", cookie: await createAppSession(fixture.app) },
    };
  }
  it("returns only roots, then children, and pages same-name people with paths", async () => {
    const { app, headers } = await setup();
    const root = await app.inject({ url: "/api/directory/departments", headers });
    expect(root.statusCode).toBe(200);
    expect(root.json().items.map((item: { id: string }) => item.id)).toEqual(["10"]);
    expect(root.json().limited).toBe(true);
    expect(root.headers["cache-control"]).toBe("private, no-store");
    const child = await app.inject({ url: "/api/directory/departments?parentId=10", headers });
    expect(child.json().items[0]).toMatchObject({ id: "11", path: "产品部 / 设计组" });
    const first = await app.inject({
      url: "/api/directory/search?kind=user&q=小王&limit=1",
      headers,
    });
    expect(first.json().items).toHaveLength(1);
    expect(first.json().nextCursor).toBe("1");
    const second = await app.inject({
      url: "/api/directory/search?kind=user&q=小王&limit=1&cursor=1",
      headers,
    });
    expect(second.json().items[0]).toMatchObject({
      kind: "user",
      id: "staff2",
      departmentPaths: ["产品部 / 设计组"],
    });
    expect(second.json().nextCursor).toBeNull();
  });
  it("rejects bad queries before directory IO and never hides failure as an empty directory", async () => {
    const { app, headers, directory } = await setup();
    for (const query of [
      "limit=51",
      "limit=0",
      "cursor=-1",
      "kind=private",
      "q=" + "x".repeat(81),
      "limit=1&limit=2",
    ]) {
      expect(
        (await app.inject({ url: `/api/directory/search?${query}`, headers })).statusCode,
      ).toBe(400);
    }
    expect(directory.getSnapshot).not.toHaveBeenCalled();
    vi.mocked(directory.getSnapshot).mockRejectedValue(
      new Error("private token and contact payload"),
    );
    const response = await app.inject({ url: "/api/directory/departments", headers });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: "directory_unavailable",
      traceId: expect.any(String),
    });
    expect(response.body).not.toContain("private token");
    expect(response.json()).not.toHaveProperty("items");
  });
  it("allows only trusted management CORS and caps per-user directory reads", async () => {
    const { app, headers } = await setup();
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/directory/search",
      headers: { origin: "http://app.localhost:3000", host: "app.localhost" },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("http://app.localhost:3000");
    for (let index = 0; index < 60; index++)
      expect((await app.inject({ url: "/api/directory/departments", headers })).statusCode).toBe(
        200,
      );
    expect((await app.inject({ url: "/api/directory/search", headers })).statusCode).toBe(429);
  });
});
