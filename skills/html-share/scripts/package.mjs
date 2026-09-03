import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inside, parseArguments, sha256 } from "./common.mjs";
import { preflight } from "./preflight.mjs";

export async function packageDemo(input) {
  const inspection = await preflight(input);
  if (inspection.blocks.length > 0) throw new Error("预检存在硬阻断，不能创建上传包。");
  if (inspection.risks.length > 0 && input.riskAckDigest !== inspection.riskAckDigest) {
    throw new Error("风险确认摘要不匹配；请重新确认当前目录的全部风险。");
  }
  const directory = await mkdtemp(join(tmpdir(), "html-share-package-"));
  const archivePath = join(directory, "demo.zip");
  const cleanupToken = randomUUID();
  try {
    await writeFile(join(directory, ".html-share-package"), cleanupToken, { flag: "wx" });
    const cleanup = () => cleanupArchive(archivePath, cleanupToken);
    await input.onPackage?.({ archivePath, cleanup, cleanupToken });
    const sourceFiles = inspection.sourceFiles;
    if (!Array.isArray(sourceFiles)) throw new Error("预检文件快照无效，不能创建上传包。");
    const records = await Promise.all(
      sourceFiles.map(async (file) => {
        const data = await readFile(file.sourcePath);
        if (sha256(data) !== file.hash) throw new Error("预检后文件发生变化，请重新检查后再发布。");
        return { data, path: file.path };
      }),
    );
    const archive = zip(records);
    await writeFile(archivePath, archive, { flag: "wx" });
    return {
      archivePath,
      archiveSize: archive.length,
      cleanup,
      cleanupToken,
      inspection,
    };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

export async function cleanupArchive(archivePath, cleanupToken) {
  const directory = dirname(resolve(archivePath));
  if (
    basename(archivePath) !== "demo.zip" ||
    !inside(tmpdir(), directory) ||
    !basename(directory).startsWith("html-share-package-")
  ) {
    throw new Error("拒绝清理非 HTML Share 临时上传包。");
  }
  const token = await readFile(join(directory, ".html-share-package"), "utf8").catch(() => null);
  if (token !== cleanupToken) throw new Error("临时上传包标记不匹配，拒绝删除。");
  await rm(directory, { force: true, recursive: true });
}

function zip(records) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const record of records) {
    const name = Buffer.from(record.path, "utf8");
    const checksum = crc32(record.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(record.data.length, 18);
    local.writeUInt32LE(record.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, record.data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(record.data.length, 20);
    header.writeUInt32LE(record.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + record.data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const ending = Buffer.alloc(22);
  ending.writeUInt32LE(0x06054b50, 0);
  ending.writeUInt16LE(records.length, 8);
  ending.writeUInt16LE(records.length, 10);
  ending.writeUInt32LE(centralSize, 12);
  ending.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, ending]);
}

function crc32(input) {
  let value = 0xffffffff;
  for (const byte of input) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  let cleanup;
  const interrupt = () => void cleanup?.().finally(() => process.exit(130));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const packaged = await packageDemo({
      onPackage: (value) => {
        cleanup = value.cleanup;
      },
      publishDir: args.publish_dir,
      riskAckDigest: args.risk_ack_digest,
      targetHtml: args.target_html,
    });
    process.stdout.write(
      JSON.stringify({
        archivePath: packaged.archivePath,
        archiveSize: packaged.archiveSize,
        cleanupToken: packaged.cleanupToken,
        manifestDigest: packaged.inspection.manifestDigest,
      }) + "\n",
    );
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  });
}
