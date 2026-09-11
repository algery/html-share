import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectContent, inspectFileName } from "../scripts/secret-hygiene.mjs";

// Inspect the actual staging tree. No scanner ignore rules may hide shipped files.
export async function inspectDistribution(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
      throw new Error("Skill 安装包不允许符号链接或特殊文件。");
    if (entry.isDirectory()) await inspectDistribution(path);
    else if (inspectFileName(path) || inspectContent(await readFile(path, "utf8")).length > 0)
      throw new Error("Skill 安装包包含敏感文件或非占位凭证，拒绝生成。");
  }
}
