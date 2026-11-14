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
  if (!isSafeRelativePath(input.returnPath)) throw new Error("RETURN_PATH_INVALID");
  const target = new URL(input.returnPath, baseUrl);
  if (target.origin !== new URL(baseUrl).origin) throw new Error("RETURN_PATH_INVALID");
  return target.toString();
}

function isSafeRelativePath(value: string) {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  );
}
