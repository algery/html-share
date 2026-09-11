/* global __ENV, __VU, crypto, open */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";
import {
  accessMode,
  authorizePassword,
  exactPath,
  passwordTarget,
  required,
  safeOptions,
} from "./password-access.js";
export { handleSummary } from "./password-access.js";

// Ten one-shot uploads stay within 60 MCP calls/minute and 10 prepares/user/minute.
export const options = {
  ...safeOptions,
  scenarios: {
    uploads: {
      executor: "per-vu-iterations",
      iterations: 1,
      maxDuration: "60s",
      vus: 10,
    },
  },
  thresholds: {
    checks: ["rate==1"],
    "http_req_duration{kind:mcp}": ["p(95)<500"],
    "http_req_duration{kind:content}": ["p(95)<500"],
    upload_processing_e2e_ms: ["p(95)<5000"],
    upload_completed: ["count==10"],
    iteration_duration: ["p(95)<60000"],
  },
};

const appHost = required("APP_HOST");
const demoBaseUrl = required("DEMO_BASE_URL").replace(/\/$/, "");
const mode = accessMode();
const demoCookie = mode === "organization" ? required("DEMO_COOKIE") : undefined;
const demoOrigin = mode === "password" ? required("DEMO_ORIGIN") : undefined;
const demoHost = required("DEMO_HOST");
const endpoint = required("MCP_ENDPOINT");
const prepareTemplate = JSON.parse(required("MCP_PREPARE_PAYLOAD_TEMPLATE"));
const sourceMap = JSON.parse(open(required("UPLOAD_SOURCE_MAP_PATH")));
const token = required("MCP_TOKEN");
if (mode === "password") prepareTemplate.params.arguments.access_mode = "password";
else if (prepareTemplate.params.arguments.access_mode === "password")
  throw new Error("Password template requires ACCESS_MODE=password");
const finalization = new Trend("upload_processing_e2e_ms", true);
const completedUploads = new Counter("upload_completed");
const sourceBodies = loadSourceBodies(prepareTemplate, sourceMap);

export default function upload() {
  const prepared = callMcp(
    replaceClientRequestId(JSON.parse(JSON.stringify(prepareTemplate)), uuid()),
  );
  uploadPreparedFiles(prepared);

  const targetHtml = prepareTemplate.params.arguments.target_html;
  const pendingContent = readPublishedFile(prepared.project_id, targetHtml);
  check(pendingContent, { "prepared upload remains invisible": (result) => result.status === 404 });

  const startedAt = Date.now();
  const complete = callMcp({
    id: `complete-${__VU}`,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: { upload_id: prepared.upload_id }, name: "complete_demo_upload" },
  });
  check(complete, {
    "upload completion accepted": (result) =>
      result.status === "processing" || result.status === "completed",
  });
  awaitCompleted(prepared, targetHtml, startedAt);
}

function uploadPreparedFiles(prepared) {
  if (!Array.isArray(prepared.uploads) || prepared.uploads.length !== sourceBodies.size) {
    throw new Error("prepare_demo_upload returned an incomplete uploads array");
  }
  const returnedPaths = new Set();
  for (const upload of prepared.uploads) {
    const relativePath = upload?.relative_path;
    if (
      typeof relativePath !== "string" ||
      returnedPaths.has(relativePath) ||
      !sourceBodies.has(relativePath)
    ) {
      throw new Error("prepare_demo_upload returned an invalid or unexpected relative_path");
    }
    returnedPaths.add(relativePath);
    const destination = uploadDestination(upload);
    const response = http.put(destination.url, sourceBodies.get(relativePath), {
      headers: destination.headers,
      tags: { kind: "object-upload", name: "object-upload" },
    });
    check(response, {
      [`file uploaded: ${relativePath}`]: (result) => result.status >= 200 && result.status < 300,
    });
  }
}

function uploadDestination(upload) {
  if (!__ENV.UPLOAD_CONNECT_HOST) return { url: upload.upload_url, headers: upload.upload_headers };
  if (
    __ENV.UPLOAD_CONNECT_HOST !== "host.docker.internal" ||
    !upload.upload_url.startsWith("http://127.0.0.1:59000/")
  )
    throw new Error("Upload host override only supports the isolated local MinIO fixture");
  return {
    url: upload.upload_url.replace("http://127.0.0.1:59000/", "http://host.docker.internal:59000/"),
    headers: { ...upload.upload_headers, Host: "127.0.0.1:59000" },
  };
}

function callMcp(payload) {
  const response = http.post(endpoint, JSON.stringify(payload), {
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Host: appHost,
      "MCP-Protocol-Version": "2025-11-25",
    },
    tags: { kind: "mcp", name: "mcp-call" },
  });
  if (!check(response, { "MCP accepted": (result) => result.status === 200 }))
    throw new Error("MCP rejected the capacity request");
  try {
    if (response.json("result.isError")) throw new Error();
    const text = response.json("result.content.0.text");
    if (typeof text !== "string") throw new Error();
    return JSON.parse(text);
  } catch {
    throw new Error("MCP did not return an accepted structured capacity result");
  }
}

function awaitCompleted(prepared, targetHtml, startedAt) {
  // At most three status calls keep all ten uploads below the global 60/min MCP limit.
  for (const waitSeconds of [1.5, 1.5, 1.5]) {
    sleep(waitSeconds);
    const status = callMcp({
      id: `status-${__VU}-${Date.now()}`,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { upload_id: prepared.upload_id }, name: "get_demo_upload_status" },
    });
    if (status.status === "completed") {
      finalization.add(Date.now() - startedAt);
      if (status.project_id !== prepared.project_id || status.upload_id !== prepared.upload_id)
        throw new Error("Completed upload identity did not match the prepared task");
      let jar;
      if (mode === "password") {
        if (
          status.access_mode !== "password" ||
          status.password_status !== "generated" ||
          !/^[A-HJ-NP-Za-kmnp-z2-9]{8}$/.test(status.access_password ?? "")
        )
          throw new Error("Password upload did not return its actual generated password");
        const target = passwordTarget(
          demoBaseUrl,
          demoHost,
          demoOrigin,
          exactPath(prepared.project_id, targetHtml),
        );
        jar = authorizePassword(target, status.access_password);
      }
      const publishedContent = readPublishedFile(prepared.project_id, targetHtml, jar);
      const readable = check(publishedContent, {
        "completed upload is readable": (result) => result.status === 200,
      });
      if (!readable)
        throw new Error("Completed upload was not readable through its intended access mode");
      completedUploads.add(1);
      return;
    }
    if (status.status === "failed" || status.status === "expired") {
      finalization.add(5001);
      throw new Error(`upload ${prepared.upload_id} ended as ${status.status}`);
    }
  }
  finalization.add(5001);
  throw new Error(`upload ${prepared.upload_id} did not complete within five seconds`);
}

function readPublishedFile(projectId, targetHtml, jar = new http.CookieJar()) {
  return http.get(demoBaseUrl + exactPath(projectId, targetHtml), {
    jar,
    redirects: 0,
    headers: { ...(demoCookie ? { Cookie: demoCookie } : {}), Host: demoHost },
    tags: { kind: "content", name: "published-file", access_mode: mode },
  });
}

function replaceClientRequestId(payload, clientRequestId) {
  const args = payload?.params?.arguments;
  if (
    typeof args !== "object" ||
    args === null ||
    args.client_request_id !== "__CLIENT_REQUEST_ID__"
  ) {
    throw new Error(
      "MCP_PREPARE_PAYLOAD_TEMPLATE must use __CLIENT_REQUEST_ID__ as params.arguments.client_request_id",
    );
  }
  args.client_request_id = clientRequestId;
  return payload;
}

function loadSourceBodies(template, sources) {
  const files = template?.params?.arguments?.files;
  if (
    !Array.isArray(files) ||
    typeof sources !== "object" ||
    sources === null ||
    Array.isArray(sources)
  ) {
    throw new Error(
      "MCP_PREPARE_PAYLOAD_TEMPLATE must contain files[] and UPLOAD_SOURCE_MAP_PATH must contain an object",
    );
  }
  const bodies = new Map();
  for (const file of files) {
    const relativePath = file?.relative_path;
    const sourcePath = typeof relativePath === "string" ? sources[relativePath] : undefined;
    if (
      typeof relativePath !== "string" ||
      typeof sourcePath !== "string" ||
      bodies.has(relativePath)
    ) {
      throw new Error("each manifest relative_path must map to one local source path");
    }
    bodies.set(relativePath, open(sourcePath, "b"));
  }
  if (Object.keys(sources).length !== bodies.size) {
    throw new Error("UPLOAD_SOURCE_MAP_PATH contains paths outside the manifest");
  }
  return bodies;
}

function uuid() {
  return crypto.randomUUID();
}
