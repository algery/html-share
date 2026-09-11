import { spawn } from "node:child_process";

const scriptArguments = process.argv.slice(2);
let environmentFile = new URL("../.env.example", import.meta.url);

if (scriptArguments[0]?.startsWith("--environment-file=")) {
  const environmentArgument = scriptArguments.shift();
  const environmentPath = environmentArgument.slice("--environment-file=".length);
  if (environmentPath.length === 0) throw new Error("environment file is required");
  environmentFile = new URL(environmentPath, import.meta.url);
}

const [entrypoint, ...arguments_] = scriptArguments;

if (!entrypoint) {
  throw new Error("entrypoint is required");
}

// Local defaults must not overwrite explicit values. This matters for the
// image build, where Next.js public values are intentionally injected as
// Docker build arguments and embedded in the browser bundle.
process.loadEnvFile(environmentFile);

const child = spawn(process.execPath, [entrypoint, ...arguments_], {
  env: process.env,
  stdio: "inherit",
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
