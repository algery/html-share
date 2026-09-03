import type { SessionAudience } from "@html-share/core";

export function readReturnPath(value: unknown) {
  if (value === undefined) return "/";
  if (typeof value !== "string" || !isSafeRelativePath(value)) return null;
  return value;
}

export function redirectToAudience(input: {
  audience: SessionAudience;
  appWebUrl: string;
  demoWebUrl: string;
  returnPath: string;
}) {
  const baseUrl = input.audience === "app" ? input.appWebUrl : input.demoWebUrl;
  return new URL(input.returnPath, baseUrl).toString();
}

function isSafeRelativePath(value: string) {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !value.includes("\u0000")
  );
}
