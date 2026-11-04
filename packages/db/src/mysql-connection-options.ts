import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import type { PrismaMariaDb } from "@prisma/adapter-mariadb";

type PoolConfig = Exclude<ConstructorParameters<typeof PrismaMariaDb>[0], string>;
type TlsConfig = Exclude<NonNullable<PoolConfig["ssl"]>, boolean>;
const PRISMA_DIRECTORY = fileURLToPath(new URL("../prisma-mysql/", import.meta.url));
const NUMBER_OPTIONS = {
  connectionLimit: 1,
  acquireTimeout: 1,
  connectTimeout: 1,
  idleTimeout: 0,
  initializationTimeout: 1,
  minDelayValidation: 0,
  minimumIdle: 0,
  leakDetectionTimeout: 0,
  socketTimeout: 0,
  queryTimeout: 0,
  keepAliveDelay: 0,
  prepareCacheLength: 0,
  maxAllowedPacket: 1,
} as const;
const ALIASES = {
  connection_limit: ["connectionLimit", 1],
  connect_timeout: ["connectTimeout", 1000],
  pool_timeout: ["acquireTimeout", 1000],
  socket_timeout: ["queryTimeout", 1000],
  max_idle_connection_lifetime: ["idleTimeout", 1],
  socket: ["socketPath", 1],
} as const;
const BOOLEAN_OPTIONS = new Set([
  "allowPublicKeyRetrieval",
  "compress",
  "resetAfterUse",
  "trace",
  "pipelining",
  "forceVersionCheck",
]);
const FALSE_OPTIONS = new Set([
  "debug",
  "debugCompress",
  "logParam",
  "logPackets",
  "multipleStatements",
  "permitLocalInfile",
  "bigIntAsNumber",
  "insertIdAsNumber",
  "decimalAsNumber",
  "dateStrings",
  "noControlAfterUse",
]);

function invalid(category: string): never {
  throw new Error(`DATABASE_URL MySQL configuration invalid: ${category}`);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return invalid("URL encoding");
  }
}

function integer(value: string, minimum: number, scale = 1): number {
  if (!/^\d+$/.test(value)) invalid("numeric option");
  const result = Number(value) * scale;
  if (!Number.isSafeInteger(result) || result < minimum || result > 2_147_483_647)
    invalid("numeric range");
  return result;
}

function boolean(value: unknown): boolean {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return invalid("boolean option");
}

function certificate(value: string, prisma: boolean): Buffer {
  if (!value) invalid("TLS file");
  if (!prisma && value.startsWith("-----BEGIN ")) return Buffer.from(value);
  try {
    const data = readFileSync(prisma ? resolve(PRISMA_DIRECTORY, value) : resolve(value));
    if (!data.length) invalid("TLS file");
    return data;
  } catch {
    return invalid("TLS file");
  }
}

/** Convert supported Prisma/native options explicitly; the driver silently ignores unknown URL keys. */
export function mysqlConnectionOptions(connectionUrl: string): PoolConfig {
  let url: URL;
  try {
    url = new URL(connectionUrl);
  } catch {
    return invalid("URL syntax");
  }
  if (url.protocol !== "mysql:" || !url.hostname || url.hash || !url.pathname.slice(1))
    invalid("URL structure");
  // URLSearchParams otherwise silently repairs malformed percent escapes and UTF-8.
  for (const item of url.search.slice(1).split("&")) decode(item.replaceAll("+", " "));
  const options: PoolConfig &
    Required<Pick<PoolConfig, "host" | "connectionLimit" | "connectTimeout" | "acquireTimeout">> & {
      permitRedirect: boolean;
    } = {
    host: decode(url.hostname.replace(/^\[|\]$/g, "")),
    port: url.port ? integer(url.port, 1) : 3306,
    user: decode(url.username),
    password: decode(url.password),
    database: decode(url.pathname.slice(1)),
    connectionLimit: 5,
    acquireTimeout: 5000,
    connectTimeout: 5000,
    timezone: "+00:00",
    charset: "utf8mb4",
    logParam: false,
    permitRedirect: false,
  };
  if ((options.port ?? 0) > 65535 || !options.user) invalid("URL structure");
  const seen = new Set<string>();
  const tlsSeen = new Set<string>();
  const tls: TlsConfig & { host: string; servername?: string } = {
    rejectUnauthorized: true,
    host: options.host,
  };
  if (!isIP(tls.host)) tls.servername = tls.host;
  let tlsEnabled: boolean | undefined;
  let hasTlsOptions = false;
  const setTls = (key: string, value: unknown, prisma = false) => {
    if (tlsSeen.has(key)) invalid("duplicate TLS option");
    tlsSeen.add(key);
    hasTlsOptions = true;
    if (key === "rejectUnauthorized") {
      if (!boolean(value)) invalid("TLS verification required");
    } else if (key === "honorCipherOrder") {
      tls.honorCipherOrder = boolean(value);
    } else if (typeof value !== "string") invalid("TLS option type");
    else if (key === "ca" || key === "cert" || key === "key" || key === "pfx")
      tls[key] = certificate(value, prisma);
    else if (key === "passphrase") tls.passphrase = value;
    else if (key === "minVersion" || key === "maxVersion") {
      if (value !== "TLSv1.2" && value !== "TLSv1.3") invalid("TLS version");
      tls[key] = value;
    } else if (key === "ciphers" || key === "ecdhCurve") {
      if (!value) invalid("TLS option");
      tls[key] = value;
    } else invalid("unsupported TLS option");
  };
  for (const [inputKey, value] of url.searchParams) {
    const alias = Object.hasOwn(ALIASES, inputKey)
      ? ALIASES[inputKey as keyof typeof ALIASES]
      : undefined;
    const key = alias?.[0] ?? inputKey;
    if (seen.has(key)) invalid("duplicate option");
    seen.add(key);
    if (Object.hasOwn(NUMBER_OPTIONS, key)) {
      const numericKey = key as keyof typeof NUMBER_OPTIONS;
      options[numericKey] = integer(value, NUMBER_OPTIONS[numericKey], alias?.[1]);
    } else if (BOOLEAN_OPTIONS.has(key)) {
      const booleanKey = key as
        | "allowPublicKeyRetrieval"
        | "compress"
        | "resetAfterUse"
        | "trace"
        | "pipelining"
        | "forceVersionCheck";
      options[booleanKey] = boolean(value);
    } else if (FALSE_OPTIONS.has(key)) {
      if (boolean(value)) invalid("unsafe option");
      // Preserve the explicitly requested safe value using the public driver config type.
      const falseKey = key as keyof Pick<
        PoolConfig,
        | "debug"
        | "debugCompress"
        | "logParam"
        | "logPackets"
        | "multipleStatements"
        | "permitLocalInfile"
        | "bigIntAsNumber"
        | "insertIdAsNumber"
        | "decimalAsNumber"
        | "dateStrings"
        | "noControlAfterUse"
        | "allowPublicKeyRetrieval"
      >;
      options[falseKey] = false;
    } else if (key === "permitRedirect") {
      if (boolean(value)) invalid("unsafe option");
      options.permitRedirect = false;
    } else if (key === "timezone") {
      if (!["Z", "+00:00", "UTC", "Etc/UTC"].includes(value)) invalid("UTC timezone required");
      options.timezone = value;
    } else if (key === "charset") {
      if (value.toLowerCase() !== "utf8mb4") invalid("utf8mb4 charset required");
      options.charset = value;
    } else if (key === "collation") {
      if (!/^utf8mb4_[a-z0-9_]+$/i.test(value)) invalid("utf8mb4 collation required");
      options.collation = value;
    } else if (key === "socketPath" || key === "rsaPublicKey" || key === "cachingRsaPublicKey") {
      if (!value) invalid("empty option");
      options[key] = value;
    } else if (key === "ssl") {
      if (value === "true" || value === "false") tlsEnabled = boolean(value);
      else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          invalid("TLS JSON");
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid("TLS JSON");
        // JSON.parse alone accepts duplicate fields, including contradictory verification settings.
        let fields: string[];
        try {
          fields = [...value.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map(
            (match) => JSON.parse(`"${match[1]}"`) as string,
          );
        } catch {
          return invalid("TLS JSON");
        }
        if (new Set(fields).size !== fields.length) invalid("duplicate TLS option");
        tlsEnabled = true;
        for (const [field, item] of Object.entries(parsed)) setTls(field, item);
      }
    } else if (key.startsWith("ssl.")) setTls(key.slice(4), value);
    else if (key === "sslcert") setTls("ca", value, true);
    else if (key === "sslidentity") setTls("pfx", value, true);
    else if (key === "sslpassword") setTls("passphrase", value);
    else if (key === "sslaccept") {
      if (value !== "strict") invalid("TLS verification required");
      setTls("rejectUnauthorized", true);
    } else invalid("unsupported option");
  }
  if (options.collation) delete options.charset; // Driver prioritizes charset over an explicit collation.
  if ((options.minimumIdle ?? 0) > options.connectionLimit) invalid("pool minimum exceeds limit");
  if (options.connectTimeout > options.acquireTimeout) {
    if (seen.has("connectTimeout")) invalid("connection timeout exceeds acquire timeout");
    options.connectTimeout = options.acquireTimeout;
  }
  if (tlsEnabled === false && hasTlsOptions) invalid("conflicting TLS options");
  if (hasTlsOptions || tlsEnabled) {
    if (tls.passphrase !== undefined && !tls.pfx && !tls.key) invalid("TLS identity required");
    if (Boolean(tls.cert) !== Boolean(tls.key) || (tls.pfx && (tls.key || tls.cert)))
      invalid("conflicting TLS identity");
    if (tls.minVersion === "TLSv1.3" && tls.maxVersion === "TLSv1.2") invalid("TLS version range");
    options.ssl = tls;
  } else if (tlsEnabled === false) options.ssl = false;
  return options;
}
