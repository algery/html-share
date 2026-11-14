import { describe, expect, it } from "vitest";
import { normalizeAccountContacts } from "./account-link.js";

describe("trusted account contacts", () => {
  it.each(["13800138000", "+86 (138) 0013-8000", "0086 13800138000"])("normalizes %s", (phone) => {
    expect(normalizeAccountContacts({ phone }).phone).toBe("+8613800138000");
  });
  it("preserves explicit international numbers and email plus/dot semantics", () => {
    expect(
      normalizeAccountContacts({ phone: "+1 (415) 555-1234", email: " A.B+Tag@Example.COM " }),
    ).toEqual({ phone: "+14155551234", email: "a.b+tag@example.com" });
  });
  it.each(["", "138****8000", "123", "+8611111111111", "+1++4155551234"])(
    "ignores invalid phone %s",
    (phone) => {
      expect(normalizeAccountContacts({ phone }).phone).toBeNull();
    },
  );
  it.each(["", "a***@example.com", "a@", "a..b@example.com", "a@-example.com", "a b@example.com"])(
    "ignores invalid email %s",
    (email) => {
      expect(normalizeAccountContacts({ email }).email).toBeNull();
    },
  );
});
