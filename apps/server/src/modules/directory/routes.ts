import type { FastifyInstance } from "fastify";
import type { DirectoryGateway } from "@html-share/core";
import { createWindowRateLimiter } from "../../plugins/rate-limit.js";
import { requireSquareSession, type SquareRequestOptions } from "../square/request.js";

interface DirectoryQuery {
  parentId?: string;
  q?: string;
  kind?: string;
  cursor?: string;
  limit?: string;
}

export function registerDirectoryRoutes(
  app: FastifyInstance,
  options: SquareRequestOptions & { directory?: DirectoryGateway },
) {
  const limiter = createWindowRateLimiter();
  for (const mode of ["departments", "search"] as const) {
    app.get<{ Querystring: DirectoryQuery }>(`/api/directory/${mode}`, async (request, reply) => {
      const session = await requireSquareSession(request, reply, options, limiter, "directory");
      if (!session) return;
      const query = parseQuery(request.query);
      if (!query) return reply.code(400).send({ error: "invalid_directory_query" });
      try {
        if (!options.directory) throw new Error("disabled");
        const snapshot = await options.directory.getSnapshot({ tenantId: session.tenantId });
        const departments = snapshot.departments.map((item) => ({
          ...item,
          kind: "department" as const,
        }));
        const users = snapshot.users.map((item) => ({ ...item, kind: "user" as const }));
        const known = new Set(departments.map((item) => item.id));
        const items =
          mode === "departments"
            ? departments.filter((item) =>
                query.parentId
                  ? item.parentId === query.parentId
                  : item.parentId === null || !known.has(item.parentId),
              )
            : [
                ...(query.kind === "user" ? [] : departments),
                ...(query.kind === "department" ? [] : users),
              ].filter((item) => {
                const paths =
                  item.kind === "department" ? item.path : item.departmentPaths.join(" / ");
                return `${item.name} ${paths}`
                  .toLocaleLowerCase()
                  .includes(query.q.toLocaleLowerCase());
              });
        items.sort(
          (left, right) =>
            left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id),
        );
        const end = query.cursor + query.limit;
        return {
          items: items.slice(query.cursor, end),
          nextCursor: end < items.length ? String(end) : null,
          limited: snapshot.limited,
        };
      } catch {
        return reply.code(503).send({
          error: "directory_unavailable",
          message: "暂时无法读取组织架构，请重试或联系管理员确认通讯录授权。",
          traceId: request.traceId,
        });
      }
    });
  }
}

function parseQuery(query: DirectoryQuery) {
  if (Object.values(query).some((value) => typeof value !== "string")) return null;
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  const cursor = query.cursor === undefined || query.cursor === "" ? 0 : Number(query.cursor);
  const q = (query.q ?? "").trim();
  const kind = query.kind ?? "all";
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    cursor > 60000 ||
    q.length > 80 ||
    !["all", "department", "user"].includes(kind) ||
    (query.parentId !== undefined && query.parentId.length > 160)
  )
    return null;
  return { limit, cursor, q, kind, parentId: query.parentId };
}
