import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { inspectContent, inspectFileName } from "./secret-hygiene.mjs";

// Read Git's index, never the working copy. Git errors and file bytes stay private.
const root = resolve(process.argv[2] ?? process.cwd());
function git(args, input) {
  return execFileSync("git", ["--no-replace-objects", "-C", root, ...args], {
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

try {
  const index = git(["ls-files", "--stage", "-z"]);
  const files = index
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, oid, stage] = entry.slice(0, tab).split(" ");
      if (tab < 0 || stage !== "0" || !/^[0-9a-f]{40,64}$/.test(oid)) throw new Error();
      return { mode, oid, file: entry.slice(tab + 1) };
    });
  const blobs = files.length
    ? git(["cat-file", "--batch"], files.map(({ oid }) => oid).join("\n") + "\n")
    : Buffer.alloc(0);
  let offset = 0;
  const findings = [];
  for (const { mode, oid, file } of files) {
    const end = blobs.indexOf(10, offset);
    const [actualOid, type, sizeText] = blobs.subarray(offset, end).toString().split(" ");
    const size = Number(sizeText);
    if (
      end < offset ||
      actualOid !== oid ||
      type !== "blob" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      end + 1 + size >= blobs.length ||
      blobs[end + 1 + size] !== 10
    ) {
      throw new Error();
    }
    const content = blobs.subarray(end + 1, end + 1 + size).toString("utf8");
    offset = end + 1 + size + 1;
    if (!/^100(?:644|755)$/.test(mode)) {
      findings.push({ file, field: "unsupported-file-mode" });
      continue;
    }
    // Every example is inspected, including commented alternative configurations.
    const example = /(?:^|\/)\.env(?:\.[^/]+)?\.example$/.test(file);
    if (inspectFileName(file) && !example) {
      findings.push({ file, field: "forbidden-sensitive-file-name" });
    }
    const normalized = content.replace(/^[ \t]*(?:#[ \t]*)?(?:export[ \t]+)?/gm, "");
    for (const reason of new Set([...inspectContent(content), ...inspectContent(normalized)])) {
      findings.push({ file, field: reason.replace(/^non-placeholder-/, "") });
    }
  }
  if (offset !== blobs.length) throw new Error();
  if (findings.length) {
    console.error(JSON.stringify({ status: "blocked", findings }));
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify({ status: "ok", indexedFiles: files.length }));
  }
} catch {
  console.error("凭据检查未完成，提交被阻止；请检查 Git 暂存区和扫描器运行环境。");
  process.exitCode = 2;
}
