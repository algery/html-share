import http from "k6/http";
import { check } from "k6";
import { accessMode, required, safeOptions } from "./password-access.js";
export { handleSummary } from "./password-access.js";

// A one-shot 100-user burst proves capacity without exceeding the 600/min
// per-session or 1200/min per-IP production limit.
export const options = {
  ...safeOptions,
  scenarios: {
    demo_reads: {
      executor: "per-vu-iterations",
      iterations: 1,
      maxDuration: "30s",
      vus: 100,
    },
  },
  thresholds: {
    checks: ["rate>0.99"],
    http_req_duration: ["p(95)<500"],
  },
};

const mode = accessMode();
const baseUrl = required("BASE_URL").replace(/\/$/, "");
const cookie = required(mode === "password" ? "PASSWORD_COOKIE" : "DEMO_COOKIE");
const demoHost = required("DEMO_HOST");
const path = required("DEMO_PATH");
if (!/^\/[a-z0-9]{5}\/.+/.test(path)) throw new Error("DEMO_PATH must identify an exact file");
if (
  mode === "password" &&
  (!baseUrl.startsWith("https://") ||
    !new RegExp(`^__Host-html_share_password_${path.split("/")[1]}=[A-Za-z0-9_-]{43}$`).test(
      cookie,
    ))
)
  throw new Error("Password reads require HTTPS and only the target project's password cookie");

export default function demoRead() {
  const response = http.get(`${baseUrl}${path}`, {
    jar: new http.CookieJar(),
    redirects: 0,
    headers: { Cookie: cookie, Host: demoHost },
    tags: { kind: "content", name: "published-file", access_mode: mode },
  });
  check(response, { "content returned": (result) => result.status === 200 });
}
