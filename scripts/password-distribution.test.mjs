import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectDistribution } from "../skills/distribution-safety.mjs";

const directories = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "password-package-safety-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
describe("actual distribution staging inspection", () => {
  it.each([".codex", ".git", "node_modules", "dist"])(
    "inspects credentials even inside %s",
    async (name) => {
      const directory = await fixture();
      await mkdir(join(directory, name));
      await writeFile(join(directory, name, "config"), "API_TOKEN=" + "synthetic-unsafe-value");
      await expect(inspectDistribution(directory)).rejects.toThrow("敏感文件");
    },
  );
  it("rejects hidden environment files and symlinks rather than silently skipping them", async () => {
    const directory = await fixture();
    await writeFile(join(directory, ".env"), "SYNTHETIC=1");
    await expect(inspectDistribution(directory)).rejects.toThrow("敏感文件");
    await rm(join(directory, ".env"));
    await symlink("missing-file", join(directory, "link"));
    await expect(inspectDistribution(directory)).rejects.toThrow("符号链接");
  });
  it("accepts a clean staged Skill", async () => {
    const directory = await fixture();
    await writeFile(join(directory, "SKILL.md"), "Use the token from the runtime environment.");
    await expect(inspectDistribution(directory)).resolves.toBeUndefined();
  });
});
