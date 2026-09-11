import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:https";

export const PROXY_IMAGES = {
  caddy: "caddy:2.11.4-alpine",
  openresty: "ghcr.io/neomantra/openresty:1.31.1.1-1-alpine",
  nginx: "html-share-password-proxy-nginx:phase13",
};

export async function command(program, args, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Proxy smoke ${program} ${args[0]} failed (${code})`));
    });
  });
}

export async function requireProxyImages(kinds = ["caddy", "openresty"]) {
  for (const kind of kinds) {
    if (!(kind in PROXY_IMAGES)) throw new Error("Unknown proxy kind");
    await command("docker", ["image", "inspect", PROXY_IMAGES[kind]]);
  }
}

export async function startPasswordProxy(kind) {
  if (!(kind in PROXY_IMAGES)) throw new Error("Unknown proxy kind");
  const directory = await mkdtemp(join(tmpdir(), "html-share-password-proxy-"));
  const name = `html-share-password-proxy-${kind}-${randomUUID().slice(0, 8)}`;
  const image = PROXY_IMAGES[kind];
  let started = false;
  let ca;
  let sourceHash;
  let effectiveHash;
  const requestOptions = { hostname: "127.0.0.1", servername: "localhost", port: 55443 };
  const close = async () => {
    if (started) {
      await command("docker", ["rm", "--force", name]);
      started = false;
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const argumentsList = [
      "create",
      "--name",
      name,
      "--label",
      "html-share-smoke=password-proxy",
      "--publish",
      "127.0.0.1:55443:443",
    ];
    if (kind === "caddy") {
      const source = await readFile(new URL("../deploy/Caddyfile", import.meta.url), "utf8");
      const effective = source
        .replaceAll("server:3001", "host.docker.internal:55100")
        .replaceAll("web:3000", "host.docker.internal:55199");
      sourceHash = hash(source);
      effectiveHash = hash(effective);
      await writeFile(join(directory, "Caddyfile"), effective);
      await mkdir(join(directory, "data"));
      argumentsList.push(
        "--env",
        "APP_HOST=127.0.0.1",
        "--env",
        "DEMO_HOST=localhost",
        "--volume",
        `${join(directory, "Caddyfile")}:/etc/caddy/Caddyfile:ro`,
        "--volume",
        `${join(directory, "data")}:/data`,
      );
    } else {
      const source = await readFile(
        new URL("../deploy/1panel/demo.locations.conf", import.meta.url),
        "utf8",
      );
      const effective = source.replace(
        "http://127.0.0.1:13001",
        "http://host.docker.internal:55100",
      );
      sourceHash = hash(source);
      effectiveHash = hash(effective);
      await writeFile(join(directory, "demo.locations.conf"), effective);
      await command("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        join(directory, "private.key"),
        "-out",
        join(directory, "certificate.pem"),
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ]);
      ca = await readFile(join(directory, "certificate.pem"));
      await writeFile(
        join(directory, "nginx.conf"),
        `worker_processes 1;
error_log /dev/stderr warn;
events { worker_connections 128; }
http {
  log_format smoke_safe '$request_method $uri $status';
  access_log /dev/stdout smoke_safe;
  server {
    listen 443 ssl;
    server_name localhost;
    ssl_certificate /smoke/certificate.pem;
    ssl_certificate_key /smoke/private.key;
    include /smoke/demo.locations.conf;
  }
}
`,
      );
      argumentsList.push("--volume", `${directory}:/smoke:ro`);
    }
    argumentsList.push(image);
    if (kind !== "caddy") argumentsList.push(kind, "-c", "/smoke/nginx.conf", "-g", "daemon off;");
    await command("docker", argumentsList);
    started = true;
    await command("docker", ["start", name]);
    const send = (path, { method = "GET", headers = {}, body } = {}) =>
      new Promise((resolve, reject) => {
        const outgoing = request(
          { ...requestOptions, path, method, ca, headers: { host: "localhost:55443", ...headers } },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.once("error", reject);
            response.once("end", () =>
              resolve({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        outgoing.once("error", reject);
        outgoing.setTimeout(5000, () => outgoing.destroy(new Error("Proxy HTTPS timed out")));
        outgoing.end(body);
      });
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        if (kind === "caddy")
          ca = await readFile(join(directory, "data/caddy/pki/authorities/local/root.crt"));
        if ((await send("/not-a-project/file")).status === 404) break;
      } catch {
        /* Local certificates and the upstream become ready asynchronously. */
      }
      if (attempt === 29) throw new Error(`${kind} proxy did not reach isolated upstream`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const version = await command("docker", [
      "exec",
      name,
      kind,
      kind === "caddy" ? "version" : "-v",
    ]);
    const inspected = JSON.parse((await command("docker", ["image", "inspect", image])).stdout)[0];
    return {
      request: send,
      close,
      evidence: {
        kind,
        image,
        imageId: inspected.Id,
        version: (version.stdout + version.stderr).trim(),
        sourceHash,
        effectiveHash,
        validationScope: kind === "nginx" ? "nginx-compatibility-only" : "actual-proxy-runtime",
      },
      async assertLogsExclude(materials, check) {
        const logs = await command("docker", ["logs", name]);
        check(
          materials.filter(Boolean).every((value) => !(logs.stdout + logs.stderr).includes(value)),
          `${kind} logs contain no passwords or credentials`,
        );
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
