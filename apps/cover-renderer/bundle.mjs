const MiB = 1024 * 1024;
export const MAX_REQUEST_BYTES = 28 * MiB + 1024 * 1024;
export const MAX_IMAGE_BYTES = MiB;
export const VIEWPORT = Object.freeze({ width: 960, height: 600 });

export function readBundle(input) {
  if (
    !input ||
    typeof input.projectKey !== "string" ||
    !/^[a-z0-9]{5}$/.test(input.projectKey) ||
    typeof input.homepage !== "string" ||
    !/\.html?$/i.test(input.homepage) ||
    !Array.isArray(input.files) ||
    input.files.length < 1 ||
    input.files.length > 500
  )
    throw new Error("INVALID_BUNDLE");

  const files = new Map();
  let totalBytes = 0;
  for (const file of input.files) {
    if (
      !file ||
      !validPath(file.path) ||
      files.has(file.path) ||
      typeof file.mimeType !== "string" ||
      !/^[a-z0-9.+-]+\/[a-z0-9.+-]+(?:; charset=utf-8)?$/i.test(file.mimeType) ||
      typeof file.data !== "string" ||
      file.data.length > Math.ceil((5 * MiB) / 3) * 4
    )
      throw new Error("INVALID_BUNDLE");

    const body = Buffer.from(file.data, "base64");
    totalBytes += body.length;
    if (body.toString("base64") !== file.data || body.length > 5 * MiB || totalBytes > 20 * MiB)
      throw new Error("INVALID_BUNDLE");
    files.set(file.path, { body, mimeType: file.mimeType });
  }

  if (!files.get(input.homepage)?.mimeType.startsWith("text/html"))
    throw new Error("INVALID_BUNDLE");
  return { projectKey: input.projectKey, homepage: input.homepage, files };
}

function validPath(path) {
  return (
    typeof path === "string" &&
    path.length <= 1024 &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !/%(?:00|2e|2f|5c)/i.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
