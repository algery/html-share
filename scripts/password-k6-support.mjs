import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fixture } from "./password-smoke-fixture.mjs";
import { responseCookies, responseState } from "./password-access-fixture.mjs";

export async function prepareK6Upload(directory) {
  const upload = fixture("k6-capacity", {
    access_mode: "password",
    client_request_id: "__CLIENT_REQUEST_ID__",
  });
  const sources = {};
  for (const [path, body] of upload.bodies) {
    const file = join(directory, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
    sources[path] = `/fixtures/${path}`;
  }
  await writeFile(join(directory, "sources.json"), JSON.stringify(sources));
  return {
    bodySize: upload.bodies.get(upload.args.target_html).length,
    environment: {
      MCP_PREPARE_PAYLOAD_TEMPLATE: JSON.stringify({
        id: "prepare",
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "prepare_demo_upload", arguments: upload.args },
      }),
      UPLOAD_SOURCE_MAP_PATH: "/fixtures/sources.json",
    },
  };
}

export async function passwordReadCookie(https, path, password, secrets, check) {
  const page = await https.request(`/auth/password?return_path=${encodeURIComponent(path)}`);
  check(page.status === 200, "k6 read fixture password page is available");
  const state = responseState(page);
  const browser = responseCookies(page);
  secrets.push(state, browser);
  const granted = await https.request("/auth/password/verify", {
    method: "POST",
    headers: {
      origin: "https://localhost:55443",
      cookie: browser,
      "content-type": "application/json",
    },
    body: JSON.stringify({ state, password }),
  });
  check(granted.status === 200, "k6 read fixture receives a real password grant");
  const name = `__Host-html_share_password_${path.split("/")[1]}=`;
  const cookie = responseCookies(granted)
    .split("; ")
    .find((value) => value.startsWith(name));
  check(Boolean(cookie), "k6 read fixture has only the target project grant");
  secrets.push(cookie, cookie.slice(name.length));
  return cookie;
}

export function startK6Worker(harness) {
  let stopped = false;
  let failure;
  const running = (async () => {
    while (!stopped) {
      try {
        const result = await harness.finalize();
        if (result === "idle") await new Promise((resolve) => setTimeout(resolve, 20));
      } catch {
        failure = new Error("Isolated k6 finalizer failed");
        break;
      }
    }
  })();
  return async () => {
    stopped = true;
    await running;
    if (failure) throw failure;
  };
}

export async function runK6(script, environment, directory, secrets, check) {
  const env = { ...process.env, ...environment, K6_HTTP_DEBUG: "", K6_LOG_OUTPUT: "none" };
  const args = [
    "run",
    "--rm",
    "-v",
    `${resolve("tests/load")}:/load:ro`,
    "-v",
    `${directory}:/fixtures:ro`,
    ...Object.keys(environment).flatMap((name) => ["-e", name]),
    "grafana/k6:latest",
    "--quiet",
    "--log-output",
    "none",
    "run",
    "--insecure-skip-tls-verify",
    `/load/${script}`,
  ];
  const result = await new Promise((resolveRun, reject) => {
    const child = spawn("docker", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk) => {
      output += chunk.toString();
      if (output.length > 2_000_000) child.kill("SIGTERM");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timeout = setTimeout(() => child.kill("SIGTERM"), 90_000);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("Could not start local k6 container"));
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveRun({ code, output });
    });
  });
  // Child output remains in memory until both known values and generic credential
  // formats have been rejected. Never print a failing output to aid debugging.
  check(
    !secrets.filter(Boolean).some((secret) => result.output.includes(secret)),
    "k6 output contains no known secret values",
  );
  check(
    !/Bearer\s+|X-Amz-(?:Signature|Credential)=|__Host-html_share_password_[a-z0-9]{5}=|"state"\s*:\s*"/i.test(
      result.output,
    ),
    "k6 output contains no token, state, cookie or signed URL fields",
  );
  const line = result.output.split("\n").find((line) => line.startsWith("K6_SUMMARY_JSON:"));
  check(Boolean(line), "k6 returned a structured summary");
  let summary;
  try {
    summary = JSON.parse(line.slice("K6_SUMMARY_JSON:".length));
  } catch {
    throw new Error("k6 structured summary was invalid");
  }
  return { code: result.code, summary, output: result.output };
}
