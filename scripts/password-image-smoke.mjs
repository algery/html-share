import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Reuses an existing dependency image only if its lock and runtime exactly match.
// No package installation, persistent image tag, or production runtime secret.
const base = "html-share-server:2026-09-06.1";
const network = process.argv.includes("--allow-network") ? "default" : "none";
const directory = await mkdtemp(join(tmpdir(), "html-share-password-image-"));
try {
  const nativeArchive = process.argv.find((value) => value.startsWith("--swc-archive="))?.slice(14);
  const nativeArgs = [];
  if (nativeArchive) {
    const archive = await readFile(nativeArchive);
    assert.equal(
      createHash("sha512").update(archive).digest("base64"),
      "H4mBso8ZTMBPtdT0PN0pBx2ayTvQuTuvS6qT13d77yVFJXAPCxkyIhLTmdMaGTJs0krQYI/qpzdHijCeihXhbg==",
      "native compiler archive matches pnpm lock integrity",
    );
    const native = join(directory, "native");
    await mkdir(native);
    await command(["-xzf", nativeArchive, "--strip-components=1", "-C", native], 30000, "tar");
    nativeArgs.push("--build-context", `native=${native}`);
  }
  const probe = await command([
    "run",
    "--rm",
    "--platform=linux/amd64",
    "--network=none",
    "--entrypoint=node",
    base,
    "-e",
    'const fs=require("node:fs"),c=require("node:crypto");console.log(JSON.stringify({node:process.version,lock:c.createHash("sha256").update(fs.readFileSync("/workspace/pnpm-lock.yaml")).digest("hex"),pnpm:require("/usr/local/lib/node_modules/pnpm/package.json").version}))',
  ]);
  const runtime = JSON.parse(probe.stdout);
  const lock = createHash("sha256")
    .update(await readFile("pnpm-lock.yaml"))
    .digest("hex");
  assert(
    runtime.lock === lock && runtime.node === "v24.20.0" && runtime.pnpm === "11.19.0",
    "offline dependency image must exactly match current lock and runtimes",
  );
  const source = `FROM ${base} AS validation
USER root
WORKDIR /workspace
# Remove old source/generated output while preserving installed dependencies.
RUN find /workspace -type d -name node_modules -prune -o -type f -exec rm -f {} +
RUN rm -rf /workspace/test-results /workspace/playwright-report /workspace/.git /workspace/.env
COPY . .
${nativeArchive ? "COPY --from=native / /workspace/node_modules/@next/swc-linux-x64-musl/" : ""}
ENV NEXT_PUBLIC_APP_URL=https://app.example.test
ENV NEXT_PUBLIC_API_URL=https://app.example.test
ENV NEXT_PUBLIC_DEMO_URL=https://demo.example.test
ENV NEXT_PUBLIC_DINGTALK_CLIENT_ID=password-test-client
ENV NEXT_PUBLIC_DINGTALK_CORP_ID=password-test-corp
RUN pnpm build
RUN node scripts/password-image-audit.mjs
USER node
CMD ["node", "apps/server/dist/main.js"]
`;
  await writeFile(join(directory, "Dockerfile"), source);
  const result = await command(
    [
      "build",
      "--platform=linux/amd64",
      `--network=${network}`,
      ...nativeArgs,
      "--file",
      join(directory, "Dockerfile"),
      "--output=type=oci,dest=" + join(directory, "validation.tar"),
      ".",
    ],
    240000,
  );
  await writeFile("/private/tmp/html-share-phase13-image-build.log", result.stdout + result.stderr);
  assert(
    (result.stdout + result.stderr).includes("password-image-audit-ok"),
    "current Linux build artifact audit actually ran",
  );
  console.log(
    JSON.stringify({
      status: "password-image-smoke-ok",
      dependencyLock: lock,
      runtime,
      scope: "current-source-linux-amd64-build-and-selected-final-filesystem-audit",
      buildNetwork: network,
      nativeCompiler: nativeArchive ? "lock-integrity-verified-official-archive" : "base-image",
      standardDockerfileColdBuild: "not-verified-offline-install-cache-missing",
      persistentImageCreated: false,
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

function command(args, timeout = 30000, executable = "docker") {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (value) => {
      stdout += value;
    });
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        // All build inputs are non-sensitive; captured output is needed for reproducible diagnosis.
        writeFile("/private/tmp/html-share-phase13-image-build.log", stdout + stderr).then(
          () => reject(new Error(`Offline image validation failed (${code}); see build log`)),
          reject,
        );
      }
    });
  });
}
