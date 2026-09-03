import { spawn } from "node:child_process";

const [entrypoint, ...arguments_] = process.argv.slice(2);

if (!entrypoint) {
  throw new Error("entrypoint is required");
}

// Local defaults must not overwrite explicit values. This matters for the
// image build, where Next.js public values are intentionally injected as
// Docker build arguments and embedded in the browser bundle.
const exampleEnvironment = new URL("../.env.example", import.meta.url);
process.loadEnvFile(exampleEnvironment);

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
