import { createHash } from "node:crypto";
import { digestManifest, mimeForPath } from "@html-share/core";

export function prepareArgs(overrides: Record<string, unknown> = {}) {
  const files = filesFor("demo");
  return {
    action: "create",
    client_request_id: "d290f1ee-6c54-4b01-90e6-d701748f0851",
    display_name: "Demo",
    files,
    manifest_digest: digestForWire(files),
    target_html: "index.html",
    ...overrides,
  };
}

export function coverArgs(uploadId: unknown) {
  return {
    upload_id: uploadId,
    homepage_path: "index.html",
    content_md5: createHash("md5").update("cover data").digest("base64"),
    size: 10,
  };
}

export function filesFor(contents: string) {
  return [manifestFile("index.html", contents)];
}

export function manifestFile(relativePath: string, contents: string) {
  const source = Buffer.from(contents);
  return {
    content_md5: createHash("md5").update(source).digest("base64"),
    mime_type: mimeForPath(relativePath),
    relative_path: relativePath,
    sha256: createHash("sha256").update(source).digest("hex"),
    size: source.length,
  };
}

export function digestForWire(files: ReturnType<typeof manifestFile>[]) {
  return digestManifest(
    files.map((file) => ({
      contentMd5: file.content_md5,
      mimeType: file.mime_type,
      relativePath: file.relative_path,
      sha256: file.sha256,
      size: file.size,
    })),
  );
}

export function responseJson(response: { content: { type: string; text?: string }[] }) {
  const text = response.content.find((item) => item.type === "text")?.text;
  if (text === undefined) throw new Error("missing MCP text result");
  return JSON.parse(text) as Record<string, unknown>;
}
