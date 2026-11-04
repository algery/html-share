import { UploadError, type FileManifestItem } from "@html-share/core";
import { assertSameText, textDigest } from "./path-identity.js";

/** Preserve full paths; digest collisions are refused before any upload is signed. */
export function assertManifestIdentity(files: readonly FileManifestItem[]) {
  const paths = new Map<string, string>();
  for (const file of files) {
    const digest = textDigest(file.relativePath).toString("hex");
    const previous = paths.get(digest);
    if (previous !== undefined) throw new UploadError("INVALID_UPLOAD_INPUT");
    paths.set(digest, file.relativePath);
  }
}

export function assertStoredUploadFiles(
  stored: readonly { relativePath: string; storageKey: string }[],
  expected: readonly FileManifestItem[],
  projectId: string,
  revisionId: string,
) {
  if (stored.length !== expected.length) throw new UploadError("INVALID_UPLOAD_INPUT");
  const paths = new Map(expected.map((file) => [file.relativePath, file]));
  for (const file of stored) {
    const original = paths.get(file.relativePath);
    if (original === undefined) throw new UploadError("INVALID_UPLOAD_INPUT");
    assertSameText(file.relativePath, original.relativePath);
    assertSameText(
      file.storageKey,
      `projects/${projectId}/revisions/${revisionId}/${original.relativePath}`,
    );
  }
}
