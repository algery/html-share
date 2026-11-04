import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { mysqlConnectionOptions } from "./mysql-connection-options.js";

const BASE = "mysql://user:secret@localhost/test";
const directory = mkdtempSync(join(tmpdir(), "mysql-options-"));
const ca = join(directory, "ca with spaces.pem");
const identity = join(directory, "client.p12");
writeFileSync(ca, "certificate bytes");
writeFileSync(identity, Buffer.from([0, 1, 2, 255]));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
function withOptions(options: Record<string, string>): string {
  return `${BASE}?${new URLSearchParams(options)}`;
}
describe("MySQL connection options", () => {
  it("uses finite defaults and decodes credentials/database exactly once", () => {
    const options = mysqlConnectionOptions(
      "mysql://user%40x:p%3Aa%2B%25%23@localhost/db%20%E4%B8%AD%F0%9F%98%80",
    );
    expect(options).toMatchObject({
      host: "localhost",
      port: 3306,
      user: "user@x",
      password: "p:a+%#",
      database: "db 中😀",
      connectionLimit: 5,
      acquireTimeout: 5000,
      connectTimeout: 5000,
      charset: "utf8mb4",
      timezone: "+00:00",
      logParam: false,
      permitRedirect: false,
    });
    expect(options.ssl).toBeUndefined();
    expect(options.bigIntAsNumber).not.toBe(true);
    expect(
      mysqlConnectionOptions(`${BASE}?allowPublicKeyRetrieval=true`).allowPublicKeyRetrieval,
    ).toBe(true);
  });
  it("handles explicit ports, encoded host names and IPv6 without driver URL parsing", () => {
    expect(mysqlConnectionOptions("mysql://u:p@[::1]:3307/db")).toMatchObject({
      host: "::1",
      port: 3307,
    });
    expect(mysqlConnectionOptions("mysql://u:p@local%68ost:65535/db")).toMatchObject({
      host: "localhost",
      port: 65535,
    });
  });
  it("converts Prisma seconds and names to native fields", () => {
    const url = withOptions({
      connection_limit: "7",
      connect_timeout: "2",
      pool_timeout: "3",
      socket_timeout: "4",
      max_idle_connection_lifetime: "60",
      socket: "/tmp/mysql.sock",
    });
    expect(mysqlConnectionOptions(url)).toMatchObject({
      connectionLimit: 7,
      connectTimeout: 2000,
      acquireTimeout: 3000,
      queryTimeout: 4000,
      idleTimeout: 60,
      socketPath: "/tmp/mysql.sock",
    });
  });
  it("preserves native pool and transport options with their original units", () => {
    const url = withOptions({
      connectionLimit: "8",
      minimumIdle: "2",
      acquireTimeout: "8000",
      connectTimeout: "6000",
      initializationTimeout: "7000",
      idleTimeout: "90",
      minDelayValidation: "100",
      leakDetectionTimeout: "2000",
      socketTimeout: "12000",
      queryTimeout: "11000",
      keepAliveDelay: "20",
      prepareCacheLength: "50",
      maxAllowedPacket: "16777216",
      compress: "true",
      resetAfterUse: "true",
    });
    expect(mysqlConnectionOptions(url)).toMatchObject({
      connectionLimit: 8,
      minimumIdle: 2,
      acquireTimeout: 8000,
      connectTimeout: 6000,
      initializationTimeout: 7000,
      idleTimeout: 90,
      minDelayValidation: 100,
      leakDetectionTimeout: 2000,
      socketTimeout: 12000,
      queryTimeout: 11000,
      keepAliveDelay: 20,
      prepareCacheLength: 50,
      maxAllowedPacket: 16777216,
      compress: true,
      resetAfterUse: true,
    });
  });
  it("shortens only the unspecified connection default to the requested acquisition bound", () => {
    expect(mysqlConnectionOptions(withOptions({ pool_timeout: "2" })).connectTimeout).toBe(2000);
    expect(() =>
      mysqlConnectionOptions(withOptions({ pool_timeout: "2", connect_timeout: "3" })),
    ).toThrow(/timeout/);
  });
  it("uses explicit utf8mb4 collation without a competing charset", () => {
    const options = mysqlConnectionOptions(
      withOptions({ collation: "utf8mb4_bin", timezone: "UTC" }),
    );
    expect(options.collation).toBe("utf8mb4_bin");
    expect(options.charset).toBeUndefined();
    expect(options.timezone).toBe("UTC");
  });
  it("loads Prisma CA and PFX files relative to the MySQL schema directory", () => {
    const prisma = fileURLToPath(new URL("../prisma-mysql/", import.meta.url));
    const options = mysqlConnectionOptions(
      withOptions({
        sslcert: relative(prisma, ca),
        sslidentity: relative(prisma, identity),
        sslpassword: "p+%#",
        sslaccept: "strict",
      }),
    );
    expect(options.ssl).toEqual({
      ca: Buffer.from("certificate bytes"),
      pfx: Buffer.from([0, 1, 2, 255]),
      passphrase: "p+%#",
      rejectUnauthorized: true,
      host: "localhost",
      servername: "localhost",
    });
  });
  it("supports native TLS file paths and inline PEM with certificate verification", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----";
    const options = mysqlConnectionOptions(
      withOptions({
        ssl: "true",
        "ssl.ca": ca,
        "ssl.cert": pem,
        "ssl.key": pem,
        "ssl.passphrase": "key secret",
        "ssl.minVersion": "TLSv1.2",
        "ssl.maxVersion": "TLSv1.3",
      }),
    );
    expect(options.ssl).toMatchObject({
      ca: Buffer.from("certificate bytes"),
      cert: Buffer.from(pem),
      key: Buffer.from(pem),
      passphrase: "key secret",
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.3",
      rejectUnauthorized: true,
    });
  });
  it("parses encoded native TLS JSON without losing verification or file options", () => {
    expect(
      mysqlConnectionOptions(
        withOptions({
          ssl: JSON.stringify({
            ca,
            rejectUnauthorized: true,
            honorCipherOrder: true,
            minVersion: "TLSv1.2",
          }),
        }),
      ).ssl,
    ).toMatchObject({
      ca: Buffer.from("certificate bytes"),
      rejectUnauthorized: true,
      honorCipherOrder: true,
      minVersion: "TLSv1.2",
    });
  });
  it("checks host identity for both DNS and IP without sending IP SNI", () => {
    expect(mysqlConnectionOptions(`${BASE}?ssl=true`).ssl).toMatchObject({
      host: "localhost",
      servername: "localhost",
    });
    expect(mysqlConnectionOptions("mysql://u:p@[::1]/db?ssl=true").ssl).toEqual({
      host: "::1",
      rejectUnauthorized: true,
    });
    expect(mysqlConnectionOptions("mysql://u:p@127.0.0.1/db?ssl=true").ssl).toEqual({
      host: "127.0.0.1",
      rejectUnauthorized: true,
    });
  });
  it.each([
    "ssl=false&sslaccept=strict",
    "ssl=false&ssl.ca=missing",
    "sslaccept=accept_invalid_certs",
    "ssl.rejectUnauthorized=false",
    "ssl.minVersion=TLSv1",
    "ssl.minVersion=TLSv1.3&ssl.maxVersion=TLSv1.2",
    "sslpassword=private",
    "ssl.cert=missing",
    "ssl.servername=other-host",
    "ssl.checkServerIdentity=false",
    "connection_limit=5&connectionLimit=5",
    "connect_timeout=5&connectTimeout=5000",
    "socket=a&socketPath=a",
    "connectionLimit=1&connectionLimit=2",
    "ssl=true&ssl=true",
    "sslaccept=strict&ssl.rejectUnauthorized=true",
    "unknown=secret",
    "__proto__=secret",
    "host=elsewhere",
    "port=1234",
    "user=override",
    "database=override",
    "charset=utf8",
    "timezone=local",
    "bigIntAsNumber=true",
    "insertIdAsNumber=true",
    "decimalAsNumber=true",
    "debug=true",
    "debugCompress=true",
    "logParam=true",
    "logPackets=true",
    "multipleStatements=true",
    "permitLocalInfile=true",
    "permitRedirect=true",
    "noControlAfterUse=true",
    "connectionLimit=0",
    "connect_timeout=0",
    "pool_timeout=0",
    "minimumIdle=6",
    "acquireTimeout=1.5",
    "connectionLimit=Infinity",
    "connectTimeout=-1",
    "connectTimeout=2147483648",
    "pool_timeout=2147483647",
    "compress=yes",
    "resetAfterUse=1",
    "socket=",
    "ssl=garbage",
    "ssl=%7B%7Dgarbage",
    "ssl=%5B%5D",
  ])("rejects unsafe, unsupported, conflicting or invalid options: %s", (query) => {
    expect(() => mysqlConnectionOptions(`${BASE}?${query}`)).toThrow(
      /^DATABASE_URL MySQL configuration invalid:/,
    );
  });
  it.each([
    { ssl: '{"rejectUnauthorized":true,"rejectUnauthorized":false}' },
    { ssl: '{"rejectUnauthorized":true,"rejectUnauthoriz\\u0065d":true}' },
    { ssl: '{"rejectUnauthorized":false}' },
    { ssl: '{"ca":["certificate"]}' },
    { ssl: JSON.stringify({ ca }), sslcert: ca },
    { "ssl.pfx": identity, "ssl.key": ca, "ssl.cert": ca },
  ])("rejects contradictory native TLS configurations", (options) => {
    expect(() => mysqlConnectionOptions(withOptions(options))).toThrow(
      /^DATABASE_URL MySQL configuration invalid:/,
    );
  });
  it.each([
    "mysql://user:password@host:65536/db",
    "mysql://user:password@host:0/db",
    "mysql://user:password@host:abc/db",
    "postgresql://user:password@host/db",
    "mysql://user:password@host/db#fragment",
    "mysql://user:password@host/",
    "mysql://user:%ZZ@host/db",
    "mysql://user:password@host/db%FF",
    `${BASE}?compress=%ZZ`,
    `${BASE}?x=%FF`,
  ])("returns sanitized URL errors", (url) => {
    expect(() => mysqlConnectionOptions(url)).toThrow(/^DATABASE_URL MySQL configuration invalid:/);
    try {
      mysqlConnectionOptions(url);
    } catch (error) {
      expect(String(error)).not.toContain("password");
      expect(String(error)).not.toContain(url);
    }
  });
  it("sanitizes real missing, directory and empty TLS-file read failures", () => {
    const empty = join(directory, "empty.pem");
    writeFileSync(empty, "");
    for (const path of [join(directory, "secret-password.pem"), directory, empty]) {
      const url = withOptions({ sslcert: path, sslpassword: "credential-marker" });
      try {
        mysqlConnectionOptions(url);
        expect.fail("must reject unreadable TLS material");
      } catch (error) {
        expect(String(error)).toBe("Error: DATABASE_URL MySQL configuration invalid: TLS file");
        expect(String(error)).not.toContain(path);
        expect(String(error)).not.toContain("credential-marker");
        expect(String(error)).not.toContain("secret");
      }
    }
  });
});
