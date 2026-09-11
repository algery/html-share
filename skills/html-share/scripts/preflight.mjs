import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, opendir, realpath, stat } from "node:fs/promises";
import { dirname, join, posix, relative, resolve } from "node:path";

import {
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  canonicalJson,
  inside,
  isMainModule,
  mimeForPath,
  normalizeRelativePath,
  parseArguments,
  sha256,
} from "./common.mjs";

const SENSITIVE_NAME =
  /(^|\/)(?:\.env(?:\..*)?|\.git(?:\/|$)|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx|crt|cer|der)|.*(?:credential|secret|password|token).*)(?:$|\/)/i;
const SECRET_CONTENT =
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|(?:ghp|github_pat)_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{16,}/;

export async function preflight(input) {
  const publishDir = resolve(required(input.publishDir, "publishDir"));
  const root = await realpath(publishDir).catch(() =>
    fail("TARGET_INVALID", publishDir, "发布目录不存在或不可读取。"),
  );
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) fail("TARGET_INVALID", publishDir, "发布目录必须是目录。");
  const targetHtml = normalizeRelativePath(required(input.targetHtml, "targetHtml"));
  const targetPath = resolve(root, targetHtml);
  const blocks = [];
  const risks = [];
  if (!inside(root, targetPath) || !/\.html?$/i.test(targetHtml)) {
    blocks.push(issue("TARGET_INVALID", targetHtml, "目标必须是目录内的 .html 或 .htm 文件。"));
  }

  const files = [];
  await walk(root, root, files, blocks);
  files.sort((left, right) => comparePaths(left.path, right.path));
  const target = files.find((file) => file.path === targetHtml);
  if (target === undefined)
    blocks.push(issue("TARGET_INVALID", targetHtml, "目标 HTML 不存在或不是普通文件。"));
  if (files.length > MAX_FILES)
    blocks.push(issue("FILE_LIMIT", ".", `文件数为 ${files.length}，上限为 ${MAX_FILES}。`));
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > MAX_TOTAL_BYTES)
    blocks.push(issue("TOTAL_SIZE_LIMIT", ".", `总大小为 ${totalSize} 字节，超过 20 MiB。`));

  for (const file of files) {
    if (file.size > MAX_FILE_BYTES)
      blocks.push(issue("FILE_SIZE_LIMIT", file.path, `文件为 ${file.size} 字节，超过 5 MiB。`));
    if (SENSITIVE_NAME.test(file.path))
      blocks.push(issue("SENSITIVE_FILE", file.path, "文件名可能包含凭证或敏感材料。"));
    if (await hasSecret(file.sourcePath))
      blocks.push(issue("SECRET_CONTENT", file.path, "文件内容匹配高置信密钥模式。"));
    if (/\.(?:html?|css|js|mjs|cjs)$/i.test(file.path)) {
      risks.push(...(await inspectReferences({ file, files })));
    }
  }
  const manifest = files.map(({ contentMd5, hash, mimeType, path, size }) => ({
    content_md5: contentMd5,
    mime_type: mimeType,
    relative_path: path,
    sha256: hash,
    size,
  }));
  const manifestDigest = sha256(
    manifest
      .map(
        (file) =>
          file.relative_path +
          "\u0000" +
          file.size +
          "\u0000" +
          file.sha256 +
          "\u0000" +
          file.content_md5 +
          "\u0000" +
          file.mime_type +
          "\n",
      )
      .join(""),
  );
  const normalizedRisks = uniqueIssues(risks);
  const riskAckDigest = sha256(
    canonicalJson({ manifestDigest, risks: normalizedRisks.map(riskKey) }),
  );
  const result = {
    blocks: uniqueIssues(blocks),
    fileCount: files.length,
    files: manifest,
    manifestDigest,
    publishDir: root,
    riskAckDigest,
    risks: normalizedRisks,
    status:
      blocks.length > 0
        ? "blocked"
        : normalizedRisks.length > 0
          ? "confirmation_required"
          : "ready",
    targetHtml,
    totalSize,
  };
  Object.defineProperty(result, "sourceFiles", { enumerable: false, value: files });
  return result;
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function walk(root, directory, files, blocks) {
  const entries = [];
  for await (const entry of await opendir(directory)) entries.push(entry.name);
  for (const name of entries.sort((left, right) => left.localeCompare(right))) {
    const location = join(directory, name);
    const entry = await lstat(location);
    if (entry.isSymbolicLink()) {
      const resolved = await realpath(location).catch(() => null);
      if (resolved === null || !inside(root, resolved)) {
        blocks.push(
          issue("PATH_ESCAPE", relative(root, location), "符号链接指向发布目录外或无法解析。"),
        );
        continue;
      }
      const resolvedStat = await stat(resolved);
      if (!resolvedStat.isFile()) {
        blocks.push(
          issue("PATH_ESCAPE", relative(root, location), "仅允许解析为目录内普通文件的符号链接。"),
        );
        continue;
      }
      await addFile(root, location, resolved, resolvedStat, files, blocks);
      continue;
    }
    if (entry.isDirectory()) await walk(root, location, files, blocks);
    else if (entry.isFile()) await addFile(root, location, location, entry, files, blocks);
    else
      blocks.push(
        issue("PATH_ESCAPE", relative(root, location), "发布目录只能包含普通文件和目录。"),
      );
  }
}

async function addFile(root, location, sourcePath, details, files, blocks) {
  const path = relative(root, location).split("\\").join("/");
  try {
    normalizeRelativePath(path);
  } catch {
    blocks.push(issue("PATH_ESCAPE", path, "文件路径无法由内容网关安全寻址。"));
    return;
  }
  const hashes = await hashFile(sourcePath);
  files.push({
    contentMd5: hashes.contentMd5,
    hash: hashes.sha256,
    logicalPath: location,
    mimeType: mimeForPath(path),
    path,
    size: details.size,
    sourcePath,
  });
}

async function inspectReferences({ file, files }) {
  const content = await readSmallText(file.sourcePath);
  if (content === null) return [];
  const results = [];
  if (/\bimport\s*\(\s*(?!["'])/.test(content) || /(?:src|href)\s*=\s*["']\s*\$\{/.test(content)) {
    results.push(issue("DYNAMIC_PATH", file.path, "存在无法静态分析的动态路径。"));
  }
  const references = content.matchAll(
    /(?:src|href)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^)'"\s]+)["']?\s*\)|@import\s+(?:url\()?\s*["']([^"']+)["']/gi,
  );
  for (const match of references) {
    const value = match[1] ?? match[2] ?? match[3];
    if (
      value === undefined ||
      value.startsWith("#") ||
      value.startsWith("data:") ||
      value.startsWith("mailto:")
    )
      continue;
    const position = `字符 ${match.index ?? 0}`;
    if (/^(?:https?:)?\/\//i.test(value))
      results.push(issue("EXTERNAL_NETWORK", file.path, `${position} 引用外部地址：${value}`));
    else if (value.startsWith("/"))
      results.push(issue("ROOT_ABSOLUTE_PATH", file.path, `${position} 使用根绝对路径：${value}`));
    else {
      const normalized = posix.normalize(
        posix.join(dirname(file.path).split("\\").join("/"), value.split(/[?#]/, 1)[0]),
      );
      if (!files.some((candidate) => candidate.path === normalized)) {
        results.push(
          issue("MISSING_LOCAL_REFERENCE", file.path, `${position} 找不到本地引用：${value}`),
        );
      }
    }
  }
  return results;
}

async function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const sha256 = createHash("sha256");
    const md5 = createHash("md5");
    createReadStream(path)
      .on("data", (chunk) => {
        sha256.update(chunk);
        md5.update(chunk);
      })
      .on("error", reject)
      .on("end", () =>
        resolveHash({ contentMd5: md5.digest("base64"), sha256: sha256.digest("hex") }),
      );
  });
}

async function hasSecret(path) {
  return new Promise((resolveSecret, reject) => {
    let tail = "";
    const stream = createReadStream(path, { encoding: "utf8" });
    stream.on("data", (chunk) => {
      const text = tail + chunk;
      if (SECRET_CONTENT.test(text)) {
        stream.destroy();
        resolveSecret(true);
        return;
      }
      tail = text.slice(-512);
    });
    stream.on("error", reject);
    stream.on("close", () => resolveSecret(false));
    stream.on("end", () => resolveSecret(false));
  });
}

async function readSmallText(path) {
  try {
    return await (await import("node:fs/promises")).readFile(path, "utf8");
  } catch {
    return null;
  }
}

function issue(id, path, message) {
  return { id, message, path };
}

function riskKey(value) {
  return `${value.id}\u0000${value.path}\u0000${value.message}`;
}

function uniqueIssues(values) {
  const entries = new Map(values.map((value) => [riskKey(value), value]));
  return [...entries.values()].sort((left, right) => riskKey(left).localeCompare(riskKey(right)));
}

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} 为必填项。`);
  return value;
}

function fail(id, path, message) {
  throw Object.assign(new Error(message), { issue: issue(id, path, message) });
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const result = await preflight({ publishDir: args.publish_dir, targetHtml: args.target_html });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === "blocked" ? 2 : 0;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
