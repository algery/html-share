"use client";

import { useEffect, useState } from "react";
import type { DirectoryPage } from "../lib/square-types";

export function useDirectoryPage<T extends { id: string; kind?: string }>(endpoint: string | null) {
  const [data, setData] = useState<DirectoryPage<T>>({
    items: [],
    nextCursor: null,
    limited: false,
  });
  const [cursor, setCursor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (endpoint === null) return;
    const controller = new AbortController();
    setStatus("loading");
    const url = `${endpoint}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
    void fetch(url, { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            response.status === 503 || response.status === 403
              ? "组织目录暂不可用或权限不足，请联系管理员检查通讯录授权后重试。"
              : response.status === 401
                ? "登录状态已过期，请重新登录。"
                : "目录加载失败，请重试。",
          );
        }
        const next = (await response.json()) as DirectoryPage<T>;
        if (controller.signal.aborted) return;
        setData((previous) => ({
          ...next,
          items:
            cursor === null
              ? next.items
              : [
                  ...new Map(
                    [...previous.items, ...next.items].map((item) => [
                      `${item.kind ?? "department"}:${item.id}`,
                      item,
                    ]),
                  ).values(),
                ],
          limited: next.limited || (cursor !== null && previous.limited),
        }));
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setMessage(error instanceof Error ? error.message : "目录加载失败，请重试。");
        setStatus("error");
      });
    return () => controller.abort();
  }, [endpoint, cursor, attempt]);
  return {
    data,
    status,
    message,
    loadMore: () => setCursor(data.nextCursor),
    retry: () => setAttempt((value) => value + 1),
  };
}
