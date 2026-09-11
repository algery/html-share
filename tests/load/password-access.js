/* global __ENV */

import http from "k6/http";
import { check } from "k6";

// Fixed request names and no URL/error tags keep signed object URLs and auth state
// out of metric exports. Never run credential scenarios with --http-debug.
export const safeOptions = {
  systemTags: ["status", "method", "name", "scenario", "check", "expected_response"],
  httpDebug: "",
};

export function handleSummary(data) {
  return { stdout: `K6_SUMMARY_JSON:${JSON.stringify(data)}\n` };
}

export function required(name) {
  const value = __ENV[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function accessMode() {
  const mode = __ENV.ACCESS_MODE ?? "organization";
  if (mode !== "organization" && mode !== "password") throw new Error("ACCESS_MODE is invalid");
  if (__ENV.K6_HTTP_DEBUG) throw new Error("HTTP debug must be disabled for credential tests");
  return mode;
}

export function exactPath(projectKey, relativePath) {
  if (
    !/^[a-z0-9]{5}$/.test(projectKey) ||
    typeof relativePath !== "string" ||
    !relativePath ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("An exact published file path is required");
  return "/" + [projectKey, ...relativePath.split("/")].map(encodeURIComponent).join("/");
}

export function passwordTarget(baseUrl, host, origin, path) {
  if (
    !/^https:\/\/[^/?#]+$/.test(baseUrl.replace(/\/$/, "")) ||
    !/^https:\/\/[^/?#]+$/.test(origin) ||
    !/^\/[a-z0-9]{5}\/.+/.test(path) ||
    path.includes("#") ||
    path.includes("?")
  )
    throw new Error("Password load tests require HTTPS and an exact path");
  if (__ENV.K6_HTTP_DEBUG) throw new Error("HTTP debug must be disabled for credential tests");
  return { baseUrl: baseUrl.replace(/\/$/, ""), host, origin, path };
}

export function openPasswordPage(target) {
  const jar = new http.CookieJar();
  const response = http.get(
    `${target.baseUrl}/auth/password?return_path=${encodeURIComponent(target.path)}`,
    {
      jar,
      redirects: 0,
      headers: { Host: target.host },
      tags: { kind: "password-page", name: "password-page" },
    },
  );
  const valid = check(response, {
    "password page is available": (value) => value.status === 200,
    "password page is not cached": (value) => header(value, "cache-control") === "no-store",
    "DingTalk login remains available": (value) =>
      typeof value.body === "string" && value.body.includes("钉钉登录打开"),
  });
  if (!valid) throw new Error("Password page was unavailable");
  let state;
  try {
    const values = JSON.parse(/const input=(\{[^\n]+\});/.exec(response.body)?.[1] ?? "null");
    if (values?.returnPath !== target.path || typeof values.state !== "string" || !values.state)
      throw new Error();
    state = values.state;
  } catch {
    throw new Error("Password page did not provide valid browser-bound state");
  }
  return { jar, state };
}

export function submitPassword(target, browser, password) {
  return http.post(
    `${target.baseUrl}/auth/password/verify`,
    JSON.stringify({ state: browser.state, password }),
    {
      jar: browser.jar,
      redirects: 0,
      headers: { Host: target.host, Origin: target.origin, "Content-Type": "application/json" },
      tags: { kind: "password-verify", name: "password-verify" },
    },
  );
}

export function authorizePassword(target, password) {
  const browser = openPasswordPage(target);
  const response = submitPassword(target, browser, password);
  let redirect;
  try {
    redirect = response.json("redirectUrl");
  } catch {
    redirect = null;
  }
  const name = `__Host-html_share_password_${target.path.split("/")[1]}`;
  const cookie = browser.jar.cookiesForURL(target.baseUrl + target.path)[name]?.[0];
  const valid = check(response, {
    "correct password granted": (value) => value.status === 200,
    "correct password never rate limited": (value) => value.status !== 429,
    "verification is not cached": (value) => header(value, "cache-control") === "no-store",
    "password return path stays exact": () => redirect === target.path,
    "project password cookie issued": () =>
      typeof cookie === "string" && /^[A-Za-z0-9_-]{43}$/.test(cookie),
  });
  if (!valid) throw new Error("Password authorization failed");
  return browser.jar;
}

export function header(response, name) {
  const key = Object.keys(response.headers).find((key) => key.toLowerCase() === name);
  return key === undefined ? undefined : response.headers[key];
}
