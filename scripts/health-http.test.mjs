import { createServer } from "node:http";
import { expect, it } from "vitest";
import { httpIsHealthy } from "./health-http.mjs";

it("preserves the virtual host and rejects non-ready HTTP responses", async () => {
  const observed = [];
  const app = createServer((request, response) => {
    observed.push(request.headers.host);
    response.writeHead(
      request.url === "/ready" && request.headers.host === "app.localhost" ? 200 : 503,
    );
    response.end();
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  try {
    const target = `http://127.0.0.1:${app.address().port}`;
    expect(await httpIsHealthy(`${target}/ready`, { host: "app.localhost" })).toBe(true);
    expect(await httpIsHealthy(`${target}/ready`, { host: "wrong.localhost" })).toBe(false);
    expect(await httpIsHealthy(`${target}/down`, { host: "app.localhost" })).toBe(false);
    expect(observed).toEqual(["app.localhost", "wrong.localhost", "app.localhost"]);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
