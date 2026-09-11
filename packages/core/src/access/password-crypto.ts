import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const PASSWORD_PATTERN = /^[A-HJ-NP-Za-kmnp-z2-9]{8}$/;
const HASH_PREFIX = "scrypt-v1$32768$8$1";
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 40 * 1024 * 1024 };
// Shared across instances: at most 80 MiB of scrypt allocations per process.
const MAX_ACTIVE_HASHES = 2;
const MAX_QUEUED_HASHES = 32;
let activeHashes = 0;
const hashWaiters: (() => void)[] = [];

async function deriveHash(password: string, salt: Buffer): Promise<Buffer> {
  if (activeHashes >= MAX_ACTIVE_HASHES) {
    if (hashWaiters.length >= MAX_QUEUED_HASHES)
      throw new Error("Password hashing capacity exceeded");
    await new Promise<void>((resolve) => hashWaiters.push(resolve));
  } else {
    activeHashes += 1;
  }
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 32, SCRYPT_OPTIONS, (error, hash) => {
        if (error) reject(new Error("Password hashing failed"));
        else resolve(hash);
      });
    });
  } finally {
    const next = hashWaiters.shift();
    if (next) next();
    else activeHashes -= 1;
  }
}

function decodeBase64(value: string, bytes: number): Buffer | null {
  if (value.length !== 4 * Math.ceil(bytes / 3)) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === bytes && decoded.toString("base64") === value ? decoded : null;
}

export function createPasswordCrypto(encryptionKey: string) {
  const key = decodeBase64(encryptionKey, 32);
  if (!key) throw new Error("Password result encryption key must be canonical Base64 of 32 bytes");

  return {
    async generate(): Promise<{ password: string; hash: string }> {
      const password = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(
        "",
      );
      const salt = randomBytes(16);
      const hash = await deriveHash(password, salt);
      return {
        password,
        hash: `${HASH_PREFIX}$${salt.toString("base64")}$${hash.toString("base64")}`,
      };
    },

    async verify(password: string, encodedHash: string): Promise<boolean> {
      const trimmed = password.trim();
      if (!PASSWORD_PATTERN.test(trimmed) || encodedHash.length !== HASH_PREFIX.length + 70)
        return false;
      const parts = encodedHash.split("$");
      if (parts.length !== 6 || parts.slice(0, 4).join("$") !== HASH_PREFIX) return false;
      const salt = decodeBase64(parts[4] ?? "", 16);
      const expected = decodeBase64(parts[5] ?? "", 32);
      if (!salt || !expected) return false;
      const actual = await deriveHash(trimmed, salt);
      return timingSafeEqual(actual, expected);
    },

    // Callers supply a stable encoding of task, owner, project and password version.
    encrypt(password: string, context: string): string {
      if (!PASSWORD_PATTERN.test(password) || !context)
        throw new Error("Invalid password encryption input");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
      cipher.setAAD(Buffer.from(context, "utf8"));
      const encrypted = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
      return `aes256gcm-v1$${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")}`;
    },

    decrypt(ciphertext: string, context: string): string {
      try {
        const prefix = "aes256gcm-v1$";
        if (!context || !ciphertext.startsWith(prefix)) throw new Error();
        const payload = decodeBase64(ciphertext.slice(prefix.length), 36);
        if (!payload) throw new Error();
        const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(0, 12), {
          authTagLength: 16,
        });
        decipher.setAAD(Buffer.from(context, "utf8"));
        decipher.setAuthTag(payload.subarray(12, 28));
        const password = Buffer.concat([
          decipher.update(payload.subarray(28)),
          decipher.final(),
        ]).toString("utf8");
        if (!PASSWORD_PATTERN.test(password)) throw new Error();
        return password;
      } catch {
        throw new Error("Password result decryption failed");
      }
    },
  };
}
