import {
  DirectoryUnavailableError,
  type DirectoryDepartment,
  type DirectorySnapshot,
} from "@html-share/core";

import type { DirectoryApi } from "./directory-http.js";
import {
  arrayValue,
  departmentIds,
  invalidDirectory,
  readDepartment,
  readUser,
  record,
  textValue,
  type RawDepartment,
} from "./directory-values.js";

const MAX_DEPARTMENTS = 10_000;
const MAX_USERS = 50_000;

export async function readDirectorySnapshot(
  api: DirectoryApi,
  signal: AbortSignal,
): Promise<DirectorySnapshot> {
  const scope = record(
    record(await api.call("/auth/scopes", undefined, signal))["auth_org_scopes"],
  );
  const roots = departmentIds(scope["authed_dept"]);
  const explicitUsers = [...new Set(arrayValue(scope["authed_user"]).map(textValue))];
  if (roots.length > MAX_DEPARTMENTS || explicitUsers.length > MAX_USERS) {
    throw new DirectoryUnavailableError("limit_exceeded");
  }
  const departments = new Map<string, RawDepartment>();
  const users = new Map<string, { id: string; name: string; departments: Set<string> }>();
  const queue: string[] = [];
  const addDepartment = (department: RawDepartment) => {
    const previous = departments.get(department.id);
    if (previous) {
      if (previous.parentId !== department.parentId || previous.name !== department.name) {
        invalidDirectory();
      }
      return;
    }
    if (departments.size >= MAX_DEPARTMENTS) throw new DirectoryUnavailableError("limit_exceeded");
    departments.set(department.id, department);
    queue.push(department.id);
  };
  const addUser = (id: string, name: string, ids: string[]) => {
    let user = users.get(id);
    if (!user) {
      if (users.size >= MAX_USERS) throw new DirectoryUnavailableError("limit_exceeded");
      user = { id, name, departments: new Set<string>() };
      users.set(id, user);
    } else if (user.name !== name) {
      invalidDirectory();
    }
    ids.forEach((department) => user.departments.add(department));
  };

  for (const root of roots) {
    const department = readDepartment(
      await api.call(
        "/topapi/v2/department/get",
        {
          dept_id: Number(root),
          language: "zh_CN",
        },
        signal,
      ),
    );
    if (department.id !== root) invalidDirectory();
    addDepartment(department);
  }
  for (const id of queue) {
    const children = arrayValue(
      await api.call(
        "/topapi/v2/department/listsub",
        {
          dept_id: Number(id),
          language: "zh_CN",
        },
        signal,
      ),
    );
    for (const child of children) {
      const department = readDepartment(child);
      if (department.parentId !== id || department.id === id) invalidDirectory();
      addDepartment(department);
    }
    await readDepartmentUsers(api, id, signal, addUser);
  }
  for (const id of explicitUsers) {
    const user = readUser(
      await api.call(
        "/topapi/v2/user/get",
        {
          userid: id,
          language: "zh_CN",
        },
        signal,
      ),
      id,
    );
    if (user.departmentIds.length === 0) invalidDirectory();
    addUser(user.id, user.name, user.departmentIds);
  }

  const projected = projectDepartments(departments);
  const paths = new Map(projected.map((department) => [department.id, department.path]));
  return {
    limited: !roots.includes("1"),
    departments: projected,
    users: [...users.values()].map((user) => ({
      id: user.id,
      name: user.name,
      departmentPaths: [...user.departments].map((id) => paths.get(id) ?? `未授权部门（${id}）`),
    })),
  };
}

async function readDepartmentUsers(
  api: DirectoryApi,
  id: string,
  signal: AbortSignal,
  addUser: (id: string, name: string, departments: string[]) => void,
) {
  const cursors = new Set<number>();
  let cursor = 0;
  while (true) {
    if (cursors.has(cursor) || cursors.size > MAX_USERS / 100) invalidDirectory();
    cursors.add(cursor);
    const page = record(
      await api.call(
        "/topapi/user/listsimple",
        {
          dept_id: Number(id),
          cursor,
          size: 100,
          contain_access_limit: false,
          language: "zh_CN",
        },
        signal,
      ),
    );
    const list = arrayValue(page["list"]);
    if (list.length > 100 || typeof page["has_more"] !== "boolean") invalidDirectory();
    for (const rawUser of list) {
      const user = record(rawUser);
      addUser(textValue(user["userid"]), textValue(user["name"]), [id]);
    }
    if (page["has_more"] === false) return;
    const next = page["next_cursor"];
    if (list.length === 0 || typeof next !== "number" || !Number.isSafeInteger(next) || next < 0) {
      invalidDirectory();
    }
    cursor = next;
  }
}

function projectDepartments(raw: Map<string, RawDepartment>): DirectoryDepartment[] {
  const paths = new Map<string, string>();
  const children = new Set(
    [...raw.values()].flatMap((entry) => (entry.parentId ? [entry.parentId] : [])),
  );
  // Iterative walks avoid stack overflows on deeply nested or malicious responses.
  for (const department of raw.values()) {
    const visiting = new Set<string>();
    const chain: RawDepartment[] = [];
    let current: RawDepartment | undefined = department;
    while (current && !paths.has(current.id)) {
      if (visiting.has(current.id)) invalidDirectory();
      visiting.add(current.id);
      chain.push(current);
      current = current.parentId ? raw.get(current.parentId) : undefined;
    }
    let path = current ? (paths.get(current.id) ?? "") : "";
    for (const item of chain.reverse()) {
      path = path ? `${path} / ${item.name}` : item.name;
      paths.set(item.id, path);
    }
  }
  return [...raw.values()].map((department) => ({
    ...department,
    parentId: department.parentId && raw.has(department.parentId) ? department.parentId : null,
    path: paths.get(department.id) ?? department.name,
    hasChildren: children.has(department.id),
  }));
}
