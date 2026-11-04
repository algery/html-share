import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// These columns implement full-string indexes without reducing text capacity.
// Each entry names one physical-only MySQL field and its logical source field.
export const MYSQL_HASH_FIELDS = {
  Tenant: { appKeyDigest: "dingtalkAppKeyRef" },
  User: { dingtalkUserDigest: "dingtalkUserId" },
  McpToken: { tokenDigestHash: "tokenDigest" },
  AccessSession: { tokenDigestHash: "tokenDigest" },
  AuthState: { stateDigestHash: "stateDigest" },
  CleanupJob: { targetIdDigest: "targetId" },
  PasswordAccessGrant: { grantHashDigest: "grantHash" },
  UploadTask: { temporaryObjectKeyDigest: "temporaryObjectKey" },
  UploadFile: { relativePathDigest: "relativePath", storageKeyDigest: "storageKey" },
  FileObject: { relativePathDigest: "relativePath", storageKeyDigest: "storageKey" },
};
export const MYSQL_ACTIVE_FIELD = "activeProjectId";

export async function readSchema(directory) {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".prisma")).sort();
  const text = (
    await Promise.all(files.map((file) => readFile(join(directory, file), "utf8")))
  ).join("\n");
  return parseSchema(text);
}

export function parseSchema(text) {
  const models = new Map();
  const enums = new Map();
  for (const match of text.matchAll(/\b(model|enum)\s+(\w+)\s*\{([^}]+)\}/g)) {
    const [, kind, name, body] = match;
    const lines = body
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .filter(Boolean);
    if (kind === "enum") {
      enums.set(name, lines.map(canonicalSpace));
      continue;
    }
    const fields = new Map();
    const attributes = [];
    for (const line of lines) {
      if (line.startsWith("@@")) {
        attributes.push(line);
        continue;
      }
      const field = /^(\w+)\s+([\w[\]?]+)(.*)$/.exec(line);
      if (!field) throw new Error(`Cannot parse ${name}: ${line}`);
      fields.set(field[1], { type: field[2], attributes: field[3].trim() });
    }
    models.set(name, { name, fields, attributes });
  }
  return { models, enums, text };
}

export function canonicalSpace(text) {
  // Space outside string literals carries no Prisma schema meaning.
  return text.replace(/"(?:\\.|[^"\\])*"|\s+/g, (part) => (part.startsWith('"') ? part : ""));
}

export function nativeType(field) {
  const match = /@db\.(\w+)(?:\(([^)]*)\))?/.exec(field.attributes);
  return match ? match[1] + (match[2] === undefined ? "" : `(${match[2]})`) : null;
}

export function databaseName(name, attributes) {
  return /@@?map\("([^"]+)"\)/.exec(attributes)?.[1] ?? name;
}

function logicalAttributes(attributes) {
  return canonicalSpace(
    attributes.replace(/@db\.\w+(?:\([^)]*\))?/g, "").replace(/@unique(?:\([^)]*\))?/g, ""),
  );
}

export function logicalModel(model, mysql = false) {
  const helpers = MYSQL_HASH_FIELDS[model.name] ?? {};
  const fields = {};
  const unique = [];
  for (const [name, field] of model.fields) {
    if (mysql && (name in helpers || (model.name === "UploadTask" && name === MYSQL_ACTIVE_FIELD)))
      continue;
    fields[name] = { type: field.type, attributes: logicalAttributes(field.attributes) };
    if (/@unique\b/.test(field.attributes)) unique.push([name]);
  }
  const attributes = [];
  for (const attribute of model.attributes) {
    const match = /^@@unique\(\[([^\]]+)\]/.exec(attribute);
    if (!match) {
      attributes.push(canonicalSpace(attribute));
      continue;
    }
    const names = match[1].split(",").map((name) => name.trim());
    if (mysql && names.includes(MYSQL_ACTIVE_FIELD) && model.name === "UploadTask") continue;
    unique.push(names.map((name) => (mysql ? (helpers[name] ?? name) : name)));
  }
  return { fields, unique: unique.map(JSON.stringify).sort(), attributes: attributes.sort() };
}

export function compareSchemas(pg, mysql) {
  const issues = [];
  const compare = (label, left, right) => {
    if (JSON.stringify(left) !== JSON.stringify(right)) issues.push(`${label} differs`);
  };
  compare("Model set", [...pg.models.keys()].sort(), [...mysql.models.keys()].sort());
  compare("Enums", [...pg.enums].sort(), [...mysql.enums].sort());
  for (const [name, model] of pg.models) {
    const other = mysql.models.get(name);
    if (!other) continue;
    compare(
      `${name} logical fields/relations/constraints`,
      logicalModel(model),
      logicalModel(other, true),
    );
    for (const [fieldName, field] of model.fields) {
      const myField = other.fields.get(fieldName);
      if (!myField) continue;
      const pgNative = nativeType(field);
      let expected = pgNative;
      if (pgNative === "Uuid") expected = "Char(36)";
      else if (field.type.replace("?", "") === "DateTime" && !pgNative) expected = "DateTime(3)";
      else if (field.type.replace("?", "") === "String" && !pgNative) expected = "LongText";
      compare(`${name}.${fieldName} physical type`, expected, nativeType(myField));
    }
    for (const [helper, source] of Object.entries(MYSQL_HASH_FIELDS[name] ?? {})) {
      const field = other.fields.get(helper);
      if (!model.fields.has(source)) issues.push(`${name}.${helper} source missing`);
      if (
        !field ||
        field.type !== "Bytes?" ||
        nativeType(field) !== "Binary(32)" ||
        !/@ignore\b/.test(field.attributes) ||
        !/@default\(dbgenerated\(\)\)/.test(field.attributes)
      ) {
        issues.push(`${name}.${helper} must be an ignored database-generated binary SHA-256`);
      }
    }
  }
  const active = mysql.models.get("UploadTask")?.fields.get(MYSQL_ACTIVE_FIELD);
  if (
    !active ||
    active.type !== "String?" ||
    nativeType(active) !== "Char(36)" ||
    !/@ignore\b/.test(active.attributes) ||
    !/@default\(dbgenerated\(\)\)/.test(active.attributes)
  ) {
    issues.push("UploadTask.activeProjectId must be an ignored generated nullable UUID");
  }
  return issues;
}
