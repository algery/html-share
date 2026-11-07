import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { SquareError } from "@html-share/core";
import { squareProject, squareTestApp } from "./square.test-helper.js";
import { createAppSession, createDemoSession } from "./phase5-session.test-helper.js";

describe("square HTTP authorization and settings", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });
  async function setup(storage?: Parameters<typeof squareTestApp>[0]) {
    const fixture = squareTestApp(storage);
    apps.push(fixture.app);
    const cookie = await createAppSession(fixture.app);
    const headers = { host: "app.localhost", cookie };
    const current = await fixture.app.inject({ url: "/api/projects/abc12/square", headers });
    return {
      ...fixture,
      headers,
      writeHeaders: {
        ...headers,
        origin: "http://app.localhost:3000",
        "x-html-share-csrf": current.json().csrfToken,
      },
    };
  }
  it("uses app sessions only and rejects untrusted origins or the content host", async () => {
    const { app, headers, repository } = await setup();
    const demoCookie = await createDemoSession(app);
    for (const url of [
      "/api/projects/abc12/square",
      "/api/square/projects",
      "/api/square/projects/abc12",
      "/api/directory/departments",
    ]) {
      for (const [input, status] of [
        [{ host: "app.localhost" }, 401],
        [{ host: "app.localhost", authorization: "Bearer mcp-does-not-authorize" }, 401],
        [{ host: "app.localhost", cookie: demoCookie }, 401],
        [{ ...headers, origin: "https://untrusted.test" }, 403],
        [{ ...headers, host: "demo.localhost" }, 404],
      ] as const)
        expect((await app.inject({ url, headers: input })).statusCode).toBe(status);
    }
    expect(repository.findVisible).not.toHaveBeenCalled();
  });
  it("requires an app session and a current visible cover before opening storage", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const getObject = vi.fn(async () => Readable.from([jpeg]));
    const { app, headers, repository } = await setup({
      createPresignedUpload: vi.fn(),
      deleteObjects: vi.fn(),
      ensurePrivateBucket: vi.fn(),
      getObject,
      headObject: vi.fn(),
      listObjects: vi.fn(),
    });
    const targetHash = "a".repeat(64);
    const key = "square-covers/private.jpg";
    const url = `/api/square/projects/abc12/cover/${targetHash}`;
    vi.mocked(repository.findVisible).mockResolvedValue({
      ...squareProject,
      cover: { status: "ready", targetHash, privateImageKey: key },
    });
    for (const denied of [
      { host: "app.localhost" },
      { host: "app.localhost", cookie: await createDemoSession(app) },
      { ...headers, host: "demo.localhost" },
    ]) {
      const response = await app.inject({ url, headers: denied });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers["content-type"]).not.toBe("image/jpeg");
    }
    expect(
      (await app.inject({ url: url.replace(targetHash, "b".repeat(64)), headers })).statusCode,
    ).toBe(404);
    expect(getObject).not.toHaveBeenCalled();
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      "cache-control": "private, no-store",
      "content-type": "image/jpeg",
      "x-content-type-options": "nosniff",
    });
    expect(response.rawPayload).toEqual(jpeg);
    expect(getObject).toHaveBeenCalledExactlyOnceWith(key);
    vi.mocked(repository.findVisible).mockResolvedValue(null);
    expect((await app.inject({ url, headers })).statusCode).toBe(404);
    expect(getObject).toHaveBeenCalledTimes(1);
  });
  it("requires CSRF and Origin, parses settings, and lets disable bypass unavailable directory", async () => {
    const { app, headers, writeHeaders, directory, repository } = await setup();
    const payload = { enabled: true, audienceType: "organization", settingsVersion: 0 };
    for (const denied of [headers, { ...headers, origin: "http://app.localhost:3000" }]) {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/projects/abc12/square",
            headers: denied,
            payload,
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(repository.saveOwnedSettings).not.toHaveBeenCalled();
    const published = await app.inject({
      method: "PUT",
      url: "/api/projects/abc12/square",
      headers: writeHeaders,
      payload,
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().settings).toMatchObject({ enabled: true, settingsVersion: 1 });
    expect(published.headers["cache-control"]).toBe("private, no-store");
    vi.mocked(directory.getSnapshot).mockRejectedValue(new Error("sensitive upstream"));
    const disabled = await app.inject({
      method: "PUT",
      url: "/api/projects/abc12/square",
      headers: writeHeaders,
      payload: { enabled: false, settingsVersion: 0 },
    });
    expect(disabled.statusCode).toBe(200);
    expect(directory.getSnapshot).not.toHaveBeenCalled();
    const failed = await app.inject({
      method: "PUT",
      url: "/api/projects/abc12/square",
      headers: writeHeaders,
      payload: { ...payload, audienceType: "selected", userIds: ["staff1"] },
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain("sensitive upstream");
    expect(repository.saveOwnedSettings).toHaveBeenCalledTimes(2);
  });
  it("maps missing and conflicting projects safely and rejects malformed input", async () => {
    const { app, writeHeaders, repository } = await setup();
    const request = {
      method: "PUT" as const,
      url: "/api/projects/abc12/square",
      headers: writeHeaders,
    };
    for (const payload of [
      {},
      { enabled: "true", settingsVersion: 0 },
      { enabled: true, settingsVersion: 0, audienceType: "selected", userIds: [] },
    ]) {
      expect((await app.inject({ ...request, payload })).statusCode).toBe(400);
    }
    vi.mocked(repository.saveOwnedSettings).mockRejectedValue(
      new SquareError("SQUARE_UPLOAD_CONFLICT", 409),
    );
    const payload = { enabled: true, settingsVersion: 0, audienceType: "organization" };
    expect((await app.inject({ ...request, payload })).statusCode).toBe(409);
    vi.mocked(repository.findOwnedSettings).mockResolvedValue(null);
    expect((await app.inject({ ...request, payload })).statusCode).toBe(404);
  });
  it("limits sharing writes by authenticated user", async () => {
    const { app, writeHeaders } = await setup();
    for (let index = 0; index < 10; index++) {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/projects/abc12/square",
            headers: writeHeaders,
            payload: { enabled: false, settingsVersion: 0 },
          })
        ).statusCode,
      ).toBe(200);
    }
    const blocked = await app.inject({
      method: "PUT",
      url: "/api/projects/abc12/square",
      headers: writeHeaders,
      payload: { enabled: false, settingsVersion: 0 },
    });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });
  it("returns a separate safe read DTO and private responses", async () => {
    const { app, headers, repository } = await setup();
    const response = await app.inject({ url: "/api/square/projects/abc12", headers });
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json().project).sort()).toEqual(
      [
        "projectId",
        "displayName",
        "creatorDisplayName",
        "updatedAt",
        "fileCount",
        "totalSize",
        "homepage",
      ].sort(),
    );
    expect(Object.keys(response.json().files[0]).sort()).toEqual(["relativePath", "size", "url"]);
    expect(response.json().files[0].url).toContain("%E4%B8%AD%E6%96%87/");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    vi.mocked(repository.findVisible).mockResolvedValue(null);
    expect((await app.inject({ url: "/api/square/projects/abc12", headers })).statusCode).toBe(404);
    for (const query of [
      "?q=" + "x".repeat(81),
      "?page=0",
      "?pageSize=100",
      "?page=wat",
      "?q=x&q=y",
      "?creator=" + "x".repeat(81),
      "?creator=x&creator=y",
    ]) {
      expect((await app.inject({ url: `/api/square/projects${query}`, headers })).statusCode).toBe(
        400,
      );
    }
    expect(repository.listVisible).not.toHaveBeenCalled();
  });
  it("forwards both trimmed search fields to the authorized list query", async () => {
    const { app, headers, repository } = await setup();
    const params = new URLSearchParams({ q: "  产品 ", creator: " 张三 " });
    const response = await app.inject({ url: `/api/square/projects?${params}`, headers });
    expect(response.statusCode).toBe(200);
    expect(repository.listVisible).toHaveBeenCalledWith(
      expect.objectContaining({ q: "产品", creator: "张三", page: 1, pageSize: 10 }),
    );
  });
});
