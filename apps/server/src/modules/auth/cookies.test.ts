import { describe, expect, it } from "vitest";

import { usesSecureSessionCookie } from "./cookies.js";

describe("session cookie security", () => {
  it("uses Secure for HTTPS deployments but permits local HTTP development", () => {
    expect(usesSecureSessionCookie("https://html-console.example.com")).toBe(true);
    expect(usesSecureSessionCookie("http://app.localhost:3001")).toBe(false);
    expect(usesSecureSessionCookie("http://127.0.0.1:3001")).toBe(false);
    expect(() => usesSecureSessionCookie("http://127.attacker.test")).toThrow(
      "Session cookies require HTTPS",
    );
    expect(() => usesSecureSessionCookie("http://127.0.0.1.attacker.test")).toThrow(
      "Session cookies require HTTPS",
    );
    expect(() => usesSecureSessionCookie("http://html-console.example.com")).toThrow(
      "Session cookies require HTTPS",
    );
  });
});
