import { scanRoot } from "./secret-hygiene.mjs";

const ROOT = process.argv.includes("--workspace")
  ? new URL("../../", import.meta.url)
  : new URL("../", import.meta.url);

const findings = await scanRoot(ROOT);

if (findings.length > 0) {
  console.error(JSON.stringify({ status: "failed", findings }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: "ok", scannedRoot: ROOT.pathname }, null, 2));
}
