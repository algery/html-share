import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

export async function startPasswordHttps() {
  const directory = await mkdtemp(join(tmpdir(), "html-share-password-tls-"));
  let server;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          join(directory, "private.key"),
          "-out",
          join(directory, "certificate.pem"),
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost",
        ],
        { stdio: "ignore" },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("Local test certificate failed")),
      );
    });
    const cert = await readFile(join(directory, "certificate.pem"));
    const key = await readFile(join(directory, "private.key"));
    server = createServer({ cert, key }, (request, response) => {
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: 55100,
          path: request.url,
          method: request.method,
          headers: { ...request.headers, host: "localhost", "x-forwarded-proto": "https" },
        },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.pipe(response);
        },
      );
      upstream.on("error", () => {
        response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(55443, "127.0.0.1", resolve);
    });
    return {
      async request(path, { method = "GET", headers = {}, body } = {}) {
        return new Promise((resolve, reject) => {
          const outgoing = httpsRequest(
            { hostname: "localhost", port: 55443, path, method, headers, ca: cert },
            (response) => {
              const chunks = [];
              response.on("data", (chunk) => chunks.push(chunk));
              response.on("error", reject);
              response.on("end", () =>
                resolve({
                  status: response.statusCode,
                  headers: response.headers,
                  body: Buffer.concat(chunks),
                }),
              );
            },
          );
          outgoing.on("error", reject);
          outgoing.setTimeout(10000, () => outgoing.destroy(new Error("HTTPS smoke timed out")));
          outgoing.end(body);
        });
      },
      async close() {
        await new Promise((resolve) => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (server) server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
