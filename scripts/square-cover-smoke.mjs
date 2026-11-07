// Run inside the no-network renderer container via node --input-type=module.
import assert from "node:assert/strict";
import { request } from "node:http";
import { networkInterfaces } from "node:os";

const socketPath = process.env.SQUARE_COVER_SOCKET ?? "/cover-ipc/render.sock";

function file(path, mimeType, content) {
  return { path, mimeType, data: Buffer.from(content).toString("base64") };
}

function render(markup, assets = []) {
  const body = JSON.stringify({
    projectKey: "test1",
    homepage: "pages/index.html",
    files: [file("pages/index.html", "text/html; charset=utf-8", markup), ...assets],
  });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: "/render",
        method: "POST",
        headers: { "content-length": Buffer.byteLength(body) },
        signal: AbortSignal.timeout(29_000),
      },
      async (res) => {
        try {
          const chunks = [];
          for await (const chunk of res) chunks.push(chunk);
          resolve({ status: res.statusCode, body: Buffer.concat(chunks) });
        } catch (error) {
          reject(error);
        }
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}

assert.notEqual(process.getuid(), 0);
assert.ok(
  Object.values(networkInterfaces())
    .flat()
    .every((network) => network.internal),
);
assert.ok(
  Object.keys(process.env).every(
    (key) => !/^(DATABASE_URL|OBJECT_STORAGE_|AUTH_STATE_SECRET)/.test(key),
  ),
);

const markup = "<body style='background:#17477b'><h1>Local homepage</h1>";
const original = await render(markup);
assert.equal(original.status, 200);
assert.equal(original.body.readUInt16BE(0), 0xffd8);
assert.ok(original.body.length < 1024 * 1024);

const dynamic = await render(
  "<body style='background:#17477b'><h1></h1><script src='../title.js'></script>",
  [
    file(
      "title.js",
      "text/javascript; charset=utf-8",
      "new Function(\"document.querySelector('h1').textContent = 'Local homepage'\")()",
    ),
  ],
);
assert.equal(dynamic.status, 200);
assert.deepEqual(dynamic.body, original.body);

const externalCases = [
  ["external image", "<img src='https://image.invalid/hero.png'>"],
  [
    "internal HTTP",
    "<script>fetch('http://169.254.169.254/latest/meta-data/').catch(()=>{})</script>",
  ],
  ["internal WebSocket", "<script>new WebSocket('ws://127.0.0.1:3001/socket')</script>"],
  ["external video", "<video src='https://media.invalid/video.mp4' autoplay></video>"],
  [
    "external asset inside a local frame",
    "<iframe src='./frame.html'></iframe>",
    [
      file(
        "pages/frame.html",
        "text/html; charset=utf-8",
        "<img src='https://image.invalid/hero.png'>",
      ),
    ],
  ],
  [
    "unpublished path",
    "<script src='/title.js'></script>",
    [file("title.js", "text/javascript; charset=utf-8", "document.write('wrong project path')")],
  ],
  ["runaway script", "<script>while (true) {}</script>"],
];
for (const [name, page, assets] of externalCases) {
  const result = await render(page, assets);
  assert.equal(result.status, 422, name);
  assert.equal(result.body.length, 0, name);
}
assert.equal((await render(markup)).status, 200, "renderer recovers after a timeout");
console.log(
  "Renderer verified: JPEG, relative scripts, no network or credentials, blocked dependencies and timeout recovery",
);
