import { request } from "node:http";
import { addAbortSignal, type Readable } from "node:stream";

import { contentTypeForPath } from "@html-share/core";
import type { ObjectStore } from "@html-share/storage";

const MiB = 1024 * 1024;
const MAX_IMAGE_BYTES = MiB;

interface Source {
  relativePath: string;
  size: bigint;
  storageKey: string;
}

async function readBounded(stream: Readable, limit: number, signal: AbortSignal) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of addAbortSignal(signal, stream)) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error("BODY_TOO_LARGE");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

export function isSquareRendererReady(socketPath: string, shutdown: AbortSignal) {
  const signal = AbortSignal.any([shutdown, AbortSignal.timeout(1_500)]);
  return new Promise<boolean>((resolve) => {
    const req = request({ socketPath, path: "/health", signal }, (res) => {
      res.resume();
      resolve(res.statusCode === 204);
    });
    req.once("error", () => resolve(false));
    req.end();
  });
}

export async function renderSquareCover(input: {
  socket: string;
  projectKey: string;
  homepage: string;
  files: Source[];
  storage: ObjectStore;
  signal: AbortSignal;
}) {
  const { socket, projectKey, homepage, files, storage, signal } = input;
  if (
    files.length < 1 ||
    files.length > 500 ||
    files.some((file) => file.size < 0n || file.size > BigInt(5 * MiB)) ||
    files.reduce((size, file) => size + file.size, 0n) > BigInt(20 * MiB)
  )
    throw new Error("BUNDLE_LIMIT");

  const bundledFiles = [];
  for (const file of files) {
    signal.throwIfAborted();
    const size = Number(file.size);
    const body = await storage.getObject(file.storageKey, {
      abortSignal: signal,
      timeoutMs: 4_000,
    });
    const bytes = await readBounded(body, size, signal);
    if (bytes.length !== size) throw new Error("INVALID_SOURCE_SIZE");
    bundledFiles.push({
      path: file.relativePath,
      mimeType: contentTypeForPath(file.relativePath),
      data: bytes.toString("base64"),
    });
  }

  const body = Buffer.from(JSON.stringify({ projectKey, homepage, files: bundledFiles }));
  return new Promise<Buffer>((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        path: "/render",
        method: "POST",
        headers: { "content-length": body.length },
        signal,
      },
      (res) => {
        if (res.statusCode !== 200 || res.headers["content-type"] !== "image/jpeg") {
          res.destroy();
          reject(new Error("RENDER_UNAVAILABLE"));
          return;
        }

        readBounded(res, MAX_IMAGE_BYTES, signal)
          .then((image) => {
            if (
              image.length < 4 ||
              image.readUInt16BE(0) !== 0xffd8 ||
              image.readUInt16BE(image.length - 2) !== 0xffd9
            )
              throw new Error("INVALID_IMAGE");
            resolve(image);
          })
          .catch(reject);
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}
