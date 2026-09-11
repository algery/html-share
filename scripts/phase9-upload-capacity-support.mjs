export async function uploadDirectFiles({ execute, files, prepared }) {
  if (!Array.isArray(prepared.uploads) || prepared.uploads.length !== files.length) {
    throw new Error("direct upload contract count mismatch");
  }
  const sourceByPath = new Map(files.map((file) => [file.relative_path, file.sourcePath]));
  try {
    await Promise.all(
      prepared.uploads.map(async (upload) => {
        const sourcePath = sourceByPath.get(upload.relative_path);
        if (sourcePath === undefined) throw new Error("unexpected upload path");
        const url = new URL(upload.upload_url);
        const resolve =
          url.hostname === "host.docker.internal"
            ? ["--resolve", "host.docker.internal:9000:127.0.0.1"]
            : [];
        const headers = Object.entries(upload.upload_headers).flatMap(([name, value]) => [
          "-H",
          `${name}: ${value}`,
        ]);
        await execute(
          "curl",
          [
            "--fail",
            "--silent",
            "--show-error",
            "--connect-timeout",
            "3",
            "--max-time",
            "10",
            ...resolve,
            ...headers,
            "--upload-file",
            sourcePath,
            upload.upload_url,
          ],
          { maxBuffer: 1_024, timeout: 12_000 },
        );
      }),
    );
  } catch {
    // execFile errors echo command arguments, including pre-signed URL material.
    throw new Error("direct file PUT failed or timed out");
  }
}

export async function cleanupTemporary({
  fixture,
  removeDirectory,
  report,
  revokeToken,
  sessionCookie,
  temporaryToken,
}) {
  const cleanupErrors = [];
  if (temporaryToken !== undefined && sessionCookie !== undefined) {
    try {
      await revokeToken(sessionCookie, temporaryToken.id);
      report({ temporaryTokenRevoked: true });
    } catch {
      cleanupErrors.push("temporary MCP token revocation failed");
    }
  }
  if (fixture !== undefined) {
    try {
      await removeDirectory(fixture.directory);
      report({ temporaryFixtureRemoved: true });
    } catch {
      cleanupErrors.push("temporary fixture removal failed");
    }
  }
  return cleanupErrors;
}
