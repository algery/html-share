import { chmod, unlink } from "node:fs/promises";
import { createServer } from "node:http";

import { chromium } from "playwright";
import { MAX_REQUEST_BYTES, readBundle } from "./bundle.mjs";
import { captureCover } from "./capture.mjs";

if (process.getuid() === 0) throw new Error("Renderer must run as an unprivileged user");
const socket = process.env.SQUARE_COVER_SOCKET ?? "/cover-ipc/render.sock";
await unlink(socket).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
const captureOptions = { executablePath: process.env.SQUARE_COVER_CHROMIUM_PATH };
// Confirm the real sandbox can render before accepting work or spending a lease.
try {
  await captureCover(
    chromium,
    readBundle({
      projectKey: "ready",
      homepage: "index.html",
      files: [
        {
          path: "index.html",
          mimeType: "text/html; charset=utf-8",
          data: Buffer.from("<!doctype html><title>Renderer readiness</title>").toString("base64"),
        },
      ],
    }),
    captureOptions,
  );
} catch {
  throw new Error("Renderer Chromium sandbox could not initialize");
}
let busy = false;
const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== "POST" || req.url !== "/render") {
    res.writeHead(404).end();
    return;
  }
  if (busy) {
    res.writeHead(429).end();
    return;
  }
  const contentLength = Number(req.headers["content-length"]);
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength < 1 ||
    contentLength > MAX_REQUEST_BYTES
  ) {
    res.writeHead(413).end();
    return;
  }

  busy = true;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) throw new Error("INVALID_BUNDLE");
      chunks.push(chunk);
    }
    const bundle = readBundle(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const image = await captureCover(chromium, bundle, captureOptions);
    res
      .writeHead(200, {
        "content-type": "image/jpeg",
        "content-length": image.length,
      })
      .end(image);
  } catch {
    // Page code, resource URLs and file contents are never logged.
    res.writeHead(422).end();
  } finally {
    busy = false;
  }
});

await new Promise((resolve, reject) => server.once("error", reject).listen(socket, resolve));
await chmod(socket, 0o660);
