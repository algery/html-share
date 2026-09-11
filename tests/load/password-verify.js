/* global __ENV */

import http from "k6/http";
import { check } from "k6";
import { Counter, Rate } from "k6/metrics";
import {
  authorizePassword,
  header,
  openPasswordPage,
  passwordTarget,
  required,
  safeOptions,
  submitPassword,
} from "./password-access.js";
export { handleSummary } from "./password-access.js";

const mode = __ENV.VERIFY_MODE ?? "correct";
if (mode !== "correct" && mode !== "wrong") throw new Error("VERIFY_MODE must be correct or wrong");
const wrong = mode === "wrong";
export const options = {
  ...safeOptions,
  scenarios: {
    password_verification: {
      executor: "per-vu-iterations",
      vus: wrong ? 1 : 20,
      iterations: wrong ? 40 : 1,
      maxDuration: "60s",
    },
  },
  thresholds: {
    checks: ["rate==1"],
    ...(wrong
      ? { password_rate_limited: ["rate>0"], password_attempts: ["count==40"] }
      : { password_authorized: ["count==20"], "http_req_duration{kind:content}": ["p(95)<500"] }),
  },
};

const target = passwordTarget(
  required("DEMO_BASE_URL"),
  required("DEMO_HOST"),
  required("DEMO_ORIGIN"),
  required("DEMO_PATH"),
);
const password = required("ACCESS_PASSWORD");
if (!/^[A-HJ-NP-Za-kmnp-z2-9]{8}$/.test(password))
  throw new Error("ACCESS_PASSWORD must be an actual generated password");
const limited = new Rate("password_rate_limited");
const attempts = new Counter("password_attempts");
const authorized = new Counter("password_authorized");

export default function verifyPassword() {
  if (!wrong) {
    const jar = authorizePassword(target, password);
    authorized.add(1);
    const content = http.get(target.baseUrl + target.path, {
      jar,
      redirects: 0,
      headers: { Host: target.host },
      tags: { kind: "content", name: "published-file" },
    });
    check(content, { "password visitor reads exact content": (value) => value.status === 200 });
    return;
  }
  const browser = openPasswordPage(target);
  const incorrectPassword = (password.startsWith("A") ? "B" : "A") + password.slice(1);
  const response = submitPassword(target, browser, incorrectPassword);
  attempts.add(1);
  limited.add(response.status === 429);
  check(response, {
    "wrong password stays unauthorized": (value) => value.status === 401 || value.status === 429,
    "rate limiting supplies retry delay": (value) =>
      value.status !== 429 || Number(header(value, "retry-after")) > 0,
    "wrong-password response is not cached": (value) =>
      header(value, "cache-control") === "no-store",
    "wrong password never grants a project cookie": (value) =>
      !Object.keys(value.cookies).some((name) =>
        /^__Host-html_share_password_[a-z0-9]{5}$/.test(name),
      ),
  });
}
