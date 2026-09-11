import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export async function uploadPreparedFiles(input, dependencies = {}) {
  const request = dependencies.request ?? fetch;
  if (
    !Array.isArray(input.uploads) ||
    input.uploads.length !== input.inspection.sourceFiles.length
  ) {
    throw new Error("服务端逐文件上传地址与本地清单数量不一致。");
  }
  const snapshots = new Map(input.inspection.sourceFiles.map((file) => [file.path, file]));
  const paths = new Set();
  const jobs = input.uploads.map((upload) => {
    if (
      typeof upload?.relative_path !== "string" ||
      typeof upload.upload_url !== "string" ||
      !isStringRecord(upload.upload_headers) ||
      paths.has(upload.relative_path)
    ) {
      throw new Error("服务端返回了无效或重复的逐文件上传地址。");
    }
    paths.add(upload.relative_path);
    const snapshot = snapshots.get(upload.relative_path);
    if (snapshot === undefined) throw new Error("服务端返回了清单外的上传路径。");
    return { snapshot, upload };
  });
  const concurrency = Math.max(1, Math.min(16, Number(input.concurrency) || 1));
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (!failed) {
        const job = jobs[next];
        next += 1;
        if (job === undefined) return;
        if (!(await uploadOneFile(job, input.timeoutMs, dependencies, request))) failed = true;
      }
    }),
  );
  return !failed;
}

async function uploadOneFile(job, timeoutMs, dependencies, request) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if ((await realpath(job.snapshot.logicalPath).catch(() => null)) !== job.snapshot.sourcePath) {
      throw new SnapshotChangedError();
    }
    const handle = await open(job.snapshot.sourcePath, "r");
    try {
      await verifySnapshot(handle, job.snapshot);
      const body = handle.createReadStream({ autoClose: false, start: 0 });
      const uploaded =
        dependencies.uploadHostOverride === undefined
          ? await putWithFetch(request, job.upload, body, timeoutMs)
          : await putWithHostOverride(job.upload, body, dependencies.uploadHostOverride, timeoutMs);
      if (uploaded) return true;
    } catch (error) {
      if (error instanceof SnapshotChangedError) throw error;
    } finally {
      await handle.close();
    }
  }
  return false;
}

async function verifySnapshot(handle, snapshot) {
  const before = await handle.stat();
  if (!before.isFile() || before.size !== snapshot.size) throw new SnapshotChangedError();
  const sha256 = createHash("sha256");
  const md5 = createHash("md5");
  await new Promise((resolveHash, reject) => {
    handle
      .createReadStream({ autoClose: false, start: 0 })
      .on("data", (chunk) => {
        sha256.update(chunk);
        md5.update(chunk);
      })
      .on("error", reject)
      .on("end", resolveHash);
  });
  const after = await handle.stat();
  if (
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    sha256.digest("hex") !== snapshot.hash ||
    md5.digest("base64") !== snapshot.contentMd5
  ) {
    throw new SnapshotChangedError();
  }
}

async function putWithFetch(request, upload, body, timeoutMs) {
  try {
    const response = await requestWithTimeout(
      request,
      upload.upload_url,
      {
        body,
        duplex: "half",
        headers: upload.upload_headers,
        method: "PUT",
      },
      timeoutMs,
    );
    return response.ok;
  } catch {
    return false;
  }
}

function putWithHostOverride(upload, body, hostname, timeoutMs) {
  const original = new URL(upload.upload_url);
  const transport = original.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolveUpload, reject) => {
    const outgoing = transport(
      {
        headers: { ...upload.upload_headers, host: original.host },
        hostname,
        method: "PUT",
        path: original.pathname + original.search,
        port: original.port,
        protocol: original.protocol,
      },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolveUpload((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300),
        );
      },
    );
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error("逐文件直传超时。")));
    outgoing.on("error", reject);
    body.on("error", reject).pipe(outgoing);
  });
}

async function requestWithTimeout(request, url, init, timeoutMs) {
  const controller = new globalThis.AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("请求超时。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isStringRecord(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

class SnapshotChangedError extends Error {
  constructor() {
    super("预检后文件发生变化，请重新检查后再发布。");
  }
}
