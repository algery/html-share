import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const directories = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Skill CLI entry points through symlinked directories", () => {
  async function alias() {
    const directory = await mkdtemp(join(tmpdir(), "html-share-cli-alias-"));
    directories.push(directory);
    await symlink(resolve("skills/html-share/scripts"), join(directory, "linked-scripts"), "dir");
    await mkdir(join(directory, "site"));
    await writeFile(join(directory, "site/index.html"), "<h1>CLI fixture</h1>");
    return directory;
  }

  it("executes preflight and emits JSON when argv and import.meta have different physical paths", async () => {
    const directory = await alias();
    const { stdout } = await run(process.execPath, [
      join(directory, "linked-scripts/preflight.mjs"),
      "--publish-dir",
      join(directory, "site"),
      "--target-html",
      "index.html",
    ]);
    expect(JSON.parse(stdout)).toMatchObject({ status: "ready", fileCount: 1 });
  });

  it("executes upload option validation through an alias instead of silently exiting zero", async () => {
    const directory = await alias();
    await expect(
      run(process.execPath, [
        join(directory, "linked-scripts/upload.mjs"),
        "--access-mode",
        "password",
        "--access-mode",
        "organization",
      ]),
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("不能重复"),
    });
  });
});
