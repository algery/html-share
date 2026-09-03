import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { digestFiles, extractArchive, inspectArchive } from "./archive-validator.js";

describe("archive validator", () => {
  it("streams a valid archive and produces the declared manifest digest", async () => {
    await withArchive(
      [
        { contents: "<h1>demo</h1>", name: "index.html" },
        { contents: "body{}", name: "style.css" },
      ],
      async (archivePath) => {
        const entries = await inspectArchive(archivePath);
        const stored = new Map<string, Buffer>();
        const extracted = await extractArchive({
          entries,
          async putFile(file) {
            const chunks: Buffer[] = [];
            for await (const chunk of file.body) chunks.push(Buffer.from(chunk));
            stored.set(file.path, Buffer.concat(chunks));
          },
          zipPath: archivePath,
        });
        expect(stored.get("index.html")?.toString()).toBe("<h1>demo</h1>");
        expect(extracted.manifestDigest).toBe(digestFiles(extracted.files));
      },
    );
  });

  it.each([
    ["../escape.html", "ARCHIVE_INVALID", undefined],
    ["index.html", "ARCHIVE_DUPLICATE_PATH", "index.html"],
  ])("rejects unsafe path entry %s", async (name, code, duplicateName) => {
    await withArchive(
      [
        { contents: "first", name },
        ...(duplicateName === undefined ? [] : [{ contents: "second", name: duplicateName }]),
      ],
      async (archivePath) => {
        await expect(inspectArchive(archivePath)).rejects.toMatchObject({ code });
      },
    );
  });

  it("rejects every symbolic link including a directory-style link", async () => {
    await withArchive(
      [{ contents: "ignored", mode: 0o120777, name: "linked-directory/" }],
      async (archivePath) => {
        await expect(inspectArchive(archivePath)).rejects.toMatchObject({
          code: "ARCHIVE_SYMLINK_FORBIDDEN",
        });
      },
    );
  });

  it("rejects declared file, total, count, and compression-ratio limits", async () => {
    await withArchive(
      [{ contents: Buffer.alloc(5 * 1024 * 1024 + 1, 7), name: "large.bin" }],
      async (archivePath) => {
        await expect(inspectArchive(archivePath)).rejects.toMatchObject({
          code: "ARCHIVE_FILE_TOO_LARGE",
        });
      },
    );
    await withArchive(
      Array.from({ length: 5 }, (_, index) => ({
        contents: Buffer.alloc(4.5 * 1024 * 1024, index),
        name: `file-${index}.bin`,
      })),
      async (archivePath) => {
        await expect(inspectArchive(archivePath)).rejects.toMatchObject({
          code: "ARCHIVE_TOTAL_TOO_LARGE",
        });
      },
    );
    await withArchive(
      Array.from({ length: 501 }, (_, index) => ({ contents: "", name: `empty-${index}` })),
      async (archivePath) => {
        await expect(inspectArchive(archivePath)).rejects.toMatchObject({
          code: "ARCHIVE_FILE_COUNT_EXCEEDED",
        });
      },
    );
    await withArchive(
      [{ compress: true, contents: Buffer.alloc(1024 * 1024), name: "bomb.txt" }],
      async (archivePath) => {
        await expect(inspectArchive(archivePath)).rejects.toMatchObject({
          code: "ARCHIVE_COMPRESSION_RATIO_EXCEEDED",
        });
      },
    );
  });
});

interface ZipFixtureEntry {
  name: string;
  contents: Buffer | string;
  compress?: boolean;
  mode?: number;
}

async function withArchive(
  entries: ZipFixtureEntry[],
  run: (archivePath: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "html-share-validator-"));
  const archivePath = join(directory, "demo.zip");
  try {
    await writeFile(archivePath, buildZip(entries));
    await run(archivePath);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function buildZip(entries: ZipFixtureEntry[]) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const source = Buffer.isBuffer(entry.contents) ? entry.contents : Buffer.from(entry.contents);
    const compressed = entry.compress ? deflateRawSync(source) : source;
    const method = entry.compress ? 8 : 0;
    const crc = crc32(source);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.mode ?? 0o100644) * 0x1_0000, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const central = Buffer.concat(centralParts);
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(entries.length, 8);
  footer.writeUInt16LE(entries.length, 10);
  footer.writeUInt32LE(central.length, 12);
  footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, footer]);
}

function crc32(buffer: Buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
