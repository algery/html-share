export function resolveHomepage(paths: readonly string[], configuredPath: string | null = null) {
  const html = paths.filter((path) => /\.html?$/i.test(path));
  if (configuredPath !== null) {
    return {
      path: html.includes(configuredPath) ? configuredPath : null,
      source: html.includes(configuredPath) ? ("manual" as const) : ("missing" as const),
    };
  }
  const path = html.includes("index.html")
    ? "index.html"
    : html.length === 1
      ? (html[0] ?? null)
      : null;
  return {
    path,
    source:
      path !== null
        ? ("automatic" as const)
        : html.length > 1
          ? ("ambiguous" as const)
          : ("none" as const),
  };
}

export function homepageLink(
  paths: readonly string[],
  configuredPath: string | null | undefined,
  projectKey: string,
  demoWebUrl: string,
) {
  const resolved = resolveHomepage(paths, configuredPath ?? null);
  return {
    ...resolved,
    configuredPath: configuredPath ?? null,
    url:
      resolved.path === null
        ? null
        : new URL(
            `/${projectKey}/${resolved.path.split("/").map(encodeURIComponent).join("/")}`,
            demoWebUrl,
          ).toString(),
  };
}
