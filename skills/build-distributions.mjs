import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const source = join(currentDirectory, "html-share");
const output = join(source, "dist");
const webDownloads = join(currentDirectory, "..", "apps", "web", "public", "skills");

export async function buildDistributions() {
  const staging = await mkdtemp(join(tmpdir(), "html-share-skill-dist-"));
  try {
    await mkdir(output, { recursive: true });
    await mkdir(webDownloads, { recursive: true });
    await buildOne(staging, ".codex/skills/html-share", "codex-html-share.zip");
    await buildOne(staging, ".claude/skills/html-share", "claude-code-html-share.zip");
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

async function buildOne(staging, target, archiveName) {
  const root = join(staging, target);
  const ignoredDirectory = join(source, "dist");
  await cp(source, root, {
    filter: (path) => !path.startsWith(ignoredDirectory) && !path.endsWith(".DS_Store"),
    recursive: true,
  });
  const archivePath = join(output, archiveName);
  await rm(archivePath, { force: true });
  await execute("zip", ["-qrX", archivePath, target], { cwd: staging });
  await cp(archivePath, join(webDownloads, archiveName));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildDistributions().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : "构建安装包失败。") + "\n");
    process.exitCode = 1;
  });
}
