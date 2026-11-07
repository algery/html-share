import { DirectoryUnavailableError } from "@html-share/core";

export function invalidDirectory(): never {
  throw new DirectoryUnavailableError("invalid_response");
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidDirectory();
  }
  return value as Record<string, unknown>;
}

export function textValue(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return invalidDirectory();
  return value;
}

export function departmentId(value: unknown): string {
  const numeric = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isSafeInteger(numeric) || numeric < 1) {
    return invalidDirectory();
  }
  return String(numeric);
}

export function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value)) return invalidDirectory();
  return value;
}

export function departmentIds(value: unknown): string[] {
  return [...new Set(arrayValue(value).map(departmentId))];
}

export interface RawDepartment {
  id: string;
  name: string;
  parentId: string | null;
}

export function readDepartment(value: unknown): RawDepartment {
  const item = record(value);
  const id = departmentId(item["dept_id"]);
  const parent = item["parent_id"];
  return {
    id,
    name: textValue(item["name"]),
    parentId: id === "1" && (parent === 0 || parent === "0") ? null : departmentId(parent),
  };
}

export function readUser(value: unknown, expectedId: string) {
  const user = record(value);
  const id = textValue(user["userid"]);
  if (id !== expectedId) return invalidDirectory();
  return {
    id,
    name: textValue(user["name"]),
    unionId: user["unionid"],
    departmentIds: departmentIds(user["dept_id_list"]),
  };
}
