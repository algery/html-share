import {
  DirectoryUnavailableError,
  type DirectoryGateway,
  type DirectoryMember,
} from "@html-share/core";

import {
  createDirectoryApi,
  withDirectoryTimeout,
  type DirectoryApi,
  type LiveDirectoryProviderOptions,
} from "./directory-http.js";
import { readDirectorySnapshot } from "./directory-snapshot.js";
import {
  arrayValue,
  departmentId,
  invalidDirectory,
  readUser,
  record,
  textValue,
} from "./directory-values.js";

export type { LiveDirectoryProviderOptions } from "./directory-http.js";

export function createLiveDirectoryProvider(
  options: LiveDirectoryProviderOptions,
): DirectoryGateway {
  const api = createDirectoryApi(options);
  return {
    getSnapshot({ tenantId }) {
      if (!tenantId.trim()) throw new DirectoryUnavailableError("identity_unconfirmed");
      return withDirectoryTimeout(60_000, (signal) => readDirectorySnapshot(api, signal));
    },
    resolveMember({ tenantId, unionId }) {
      if (!tenantId.trim() || !unionId.trim())
        throw new DirectoryUnavailableError("identity_unconfirmed");
      return withDirectoryTimeout(60_000, (signal) => readMember(api, unionId, signal));
    },
  };
}

export function createDisabledDirectoryProvider(): DirectoryGateway {
  const unavailable = async (): Promise<never> => {
    throw new DirectoryUnavailableError("disabled");
  };
  return { getSnapshot: unavailable, resolveMember: unavailable };
}

async function readMember(
  api: DirectoryApi,
  unionId: string,
  signal: AbortSignal,
): Promise<DirectoryMember> {
  const mapping = record(await api.call("/topapi/user/getbyunionid", { unionid: unionId }, signal));
  if (mapping["contact_type"] !== 0) throw new DirectoryUnavailableError("identity_unconfirmed");
  const userId = textValue(mapping["userid"]);
  const user = readUser(
    await api.call(
      "/topapi/v2/user/get",
      {
        userid: userId,
        language: "zh_CN",
      },
      signal,
    ),
    userId,
  );
  if (user.unionId !== unionId || user.departmentIds.length === 0) {
    throw new DirectoryUnavailableError("identity_unconfirmed");
  }
  if (user.departmentIds.length > 10_000) throw new DirectoryUnavailableError("limit_exceeded");
  const departmentSet = new Set<string>();
  for (const id of user.departmentIds) {
    const result = record(
      await api.call(
        "/topapi/v2/department/listparentbydept",
        {
          dept_id: Number(id),
        },
        signal,
      ),
    );
    const parents = arrayValue(result["parent_id_list"]).map(departmentId);
    if (parents[0] !== id || parents.at(-1) !== "1" || new Set(parents).size !== parents.length) {
      invalidDirectory();
    }
    parents.forEach((parent) => departmentSet.add(parent));
    if (departmentSet.size > 10_000) throw new DirectoryUnavailableError("limit_exceeded");
  }
  return { userId, departmentIds: [...departmentSet] };
}
