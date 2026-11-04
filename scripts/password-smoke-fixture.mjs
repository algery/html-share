import { createHash, randomUUID } from "node:crypto";
import { createDatabaseClient } from "../packages/db/dist/index.js";
import { directManifestDigest } from "./direct-upload-smoke-support.mjs";
export function isolatedConfiguration() {
  if (process.env.PHASE25_DATABASE_PROVIDER !== undefined) {
    const provider = process.env.PHASE25_DATABASE_PROVIDER;
    const databaseUrl = process.env.PHASE25_DATABASE_URL;
    const endpoint = process.env.PHASE10_MINIO_ENDPOINT;
    const url = new URL(databaseUrl ?? "invalid:");
    if (
      !["postgresql", "mysql"].includes(provider) ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/html_share_phase25_http" ||
      url.port !== (provider === "mysql" ? "53319" : "55439") ||
      !(provider === "mysql"
        ? url.protocol === "mysql:"
        : ["postgresql:", "postgres:"].includes(url.protocol)) ||
      endpoint !== "http://127.0.0.1:59000"
    ) {
      throw new Error("Isolated Phase 25 HTTP databases and MinIO are required");
    }
    if (process.versions.node.split(".")[0] !== "24") throw new Error("Node.js 24 is required");
    return {
      databaseProvider: provider,
      databaseUrl,
      endpoint,
      accessKeyId: "password_test",
      accessKeySecret: "local-password-test-only",
    };
  }
  const databaseUrl = process.env.PHASE10_DATABASE_URL;
  const endpoint = process.env.PHASE10_MINIO_ENDPOINT;
  const expectedDatabase =
    "postgres://password_test:local-password-test-only@127.0.0.1:55432/html_share_password";
  if (databaseUrl !== expectedDatabase || endpoint !== "http://127.0.0.1:59000") {
    throw new Error("isolated PHASE10_DATABASE_URL and PHASE10_MINIO_ENDPOINT are required");
  }
  if (process.versions.node.split(".")[0] !== "24") throw new Error("Node.js 24 is required");
  return {
    databaseUrl,
    endpoint,
    accessKeyId: "password_test",
    accessKeySecret: "local-password-test-only",
  };
}

export function fixture(version, overrides = {}) {
  const bodies = new Map([
    ["nested/测试 file.html", Buffer.from(`<!doctype html><h1>version ${version}</h1>`)],
    ["assets/style.css", Buffer.from(`body{--version:${version}}`)],
  ]);
  const files = [...bodies].map(([relative_path, body]) => ({
    relative_path,
    size: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    content_md5: createHash("md5").update(body).digest("base64"),
    mime_type: relative_path.endsWith(".html")
      ? "text/html; charset=utf-8"
      : "text/css; charset=utf-8",
  }));
  return {
    bodies,
    args: {
      action: "create",
      client_request_id: randomUUID(),
      display_name: "Password publication smoke",
      target_html: files[0].relative_path,
      files,
      manifest_digest: directManifestDigest(files),
      ...overrides,
    },
  };
}

export function createSmokeDatabase(config) {
  return createDatabaseClient({
    DATABASE_PROVIDER: config.databaseProvider ?? "postgresql",
    DATABASE_URL: config.databaseUrl,
  });
}
