import { randomBytes, scrypt as nodeScrypt } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { createPasswordCrypto } from "./password-crypto.js";

const key = randomBytes(32).toString("base64");
const crypto = createPasswordCrypto(key);
const context = JSON.stringify(["task-1", "owner-1", "project-1", 1]);

async function fixtureHash(password: string, salt = randomBytes(16)) {
  const hash = await new Promise<Buffer>((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      32,
      { N: 32768, r: 8, p: 1, maxmem: 40 * 1024 * 1024 },
      (error, hash) => {
        if (error) reject(error);
        else resolve(hash);
      },
    );
  });
  return `scrypt-v1$32768$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

describe("password crypto", () => {
  it("generates eight unambiguous random characters with independent salts and verifiable hashes", async () => {
    const values = await Promise.all(Array.from({ length: 12 }, () => crypto.generate()));
    expect(new Set(values.map(({ password }) => password)).size).toBe(values.length);
    expect(new Set(values.map(({ hash }) => hash.split("$")[4])).size).toBe(values.length);
    for (const { password, hash } of values) {
      expect(password).toMatch(/^[A-Za-z2-9]{8}$/);
      expect(password).not.toMatch(/[IOlo01]/);
      expect(hash).not.toContain(password);
      expect(await crypto.verify(password, hash)).toBe(true);
    }
  });

  it("accepts only trimming at the ends, preserving case and interior characters", async () => {
    const hash = await fixtureHash("AbCd2xY9");
    expect(await crypto.verify(" \tAbCd2xY9\n", hash)).toBe(true);
    for (const invalid of [
      "abcd2xy9",
      "AbCd 2xY9",
      "AbCd2xY8",
      "ＡbCd2xY9",
      "",
      " ",
      "a".repeat(10_000),
    ]) {
      expect(await crypto.verify(invalid, hash)).toBe(false);
    }
  });

  it("rejects malformed hashes and attacker-controlled cost without throwing", async () => {
    const hash = await fixtureHash("AbCd2xY9");
    const malformed = [
      "",
      "scrypt",
      hash + "$extra",
      hash.replace("32768", "99999"),
      hash.replace("scrypt-v1", "scrypt-v2"),
      hash.replace("$8$1$", "$9$1$"),
      hash.slice(0, -1),
      hash.replace(/.$/, "!"),
      hash.replace(/.$/, "A"),
      hash.replace("$", " "),
      "x".repeat(10_000),
    ];
    for (const value of malformed) expect(await crypto.verify("AbCd2xY9", value)).toBe(false);
  });

  it("lets the event loop progress while scrypt is pending", async () => {
    let completed = false;
    const pending = crypto.generate().then(() => {
      completed = true;
    });
    await setImmediate();
    expect(completed).toBe(false);
    await pending;
  });

  it("bounds queued work across instances and recovers after rejecting excess work", async () => {
    const instances = Array.from({ length: 35 }, () => createPasswordCrypto(key));
    const results = await Promise.allSettled(instances.map((instance) => instance.generate()));
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(34);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const generated = await crypto.generate();
    expect(await crypto.verify(generated.password, generated.hash)).toBe(true);
  });

  it("requires exactly 32 bytes in canonical Base64 without revealing invalid keys", () => {
    const invalidKeys = [
      "",
      "secret",
      key.trimEnd() + "\n",
      key.slice(0, -1),
      randomBytes(31).toString("base64"),
      randomBytes(33).toString("base64"),
    ];
    for (const invalid of invalidKeys) {
      expect(() => createPasswordCrypto(invalid)).toThrow(
        "Password result encryption key must be canonical Base64 of 32 bytes",
      );
    }
  });

  it("encrypts with a fresh IV and round-trips only within the bound context", () => {
    const first = crypto.encrypt("AbCd2xY9", context);
    const second = crypto.encrypt("AbCd2xY9", context);
    expect(first).not.toBe(second);
    expect(first).not.toContain("AbCd2xY9");
    expect(crypto.decrypt(first, context)).toBe("AbCd2xY9");
    expect(crypto.decrypt(second, context)).toBe("AbCd2xY9");
    for (const changed of [
      ["task-2", "owner-1", "project-1", 1],
      ["task-1", "owner-2", "project-1", 1],
      ["task-1", "owner-1", "project-2", 1],
      ["task-1", "owner-1", "project-1", 2],
    ]) {
      expect(() => crypto.decrypt(first, JSON.stringify(changed))).toThrow(
        "Password result decryption failed",
      );
    }
    expect(() =>
      createPasswordCrypto(randomBytes(32).toString("base64")).decrypt(first, context),
    ).toThrow("Password result decryption failed");
  });

  it("rejects altered IV, tag, payload and malformed envelopes with a generic error", () => {
    const encrypted = crypto.encrypt("AbCd2xY9", context);
    const encoded = encrypted.split("$")[1] ?? "";
    for (const index of [0, 12, 28]) {
      const payload = Buffer.from(encoded, "base64");
      payload[index] = (payload[index] ?? 0) ^ 1;
      expect(() => crypto.decrypt(`aes256gcm-v1$${payload.toString("base64")}`, context)).toThrow(
        "Password result decryption failed",
      );
    }
    for (const malformed of [
      "",
      encrypted + "=",
      encrypted.replace("v1", "v2"),
      encrypted.slice(0, -1),
      encrypted + "$extra",
      "x".repeat(10_000),
    ]) {
      expect(() => crypto.decrypt(malformed, context)).toThrow("Password result decryption failed");
    }
    expect(() => crypto.decrypt(encrypted, "")).toThrow("Password result decryption failed");
    expect(() => crypto.encrypt("AbCd2xY9", "")).toThrow("Invalid password encryption input");
    expect(() => crypto.encrypt("invalid", context)).toThrow("Invalid password encryption input");
  });
});
