import { normalizeRelativePath } from "@html-share/core";

export interface DemoContentPath {
  projectKey: string;
  relativePath: string;
}

export function resolveDemoContentPath(requestUrl: string): DemoContentPath | null {
  const rawPath = requestUrl.split("?", 1)[0] ?? "";
  if (rawPath.length === 0 || rawPath.includes("\\") || /%(?:2f|5c)/i.test(rawPath)) {
    return null;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (
    !pathname.startsWith("/") ||
    /%(?:00|2e|2f|5c)/i.test(pathname) ||
    pathname.includes("\\") ||
    pathname.includes("\0")
  ) {
    return null;
  }

  const segments = pathname.slice(1).split("/");
  const projectKey = segments.shift();
  if (
    projectKey === undefined ||
    !/^[a-z0-9]{5}$/.test(projectKey) ||
    segments.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return null;
  }
  let relativePath: string;
  try {
    relativePath = normalizeRelativePath(segments.join("/"));
  } catch {
    return null;
  }
  return { projectKey, relativePath };
}
