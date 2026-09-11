export function mcpHarness(options = {}) {
  let preparedFiles = [];
  return {
    request: async (url, init = {}) => {
      if (String(url).startsWith("https://storage.test/")) {
        await options.onUpload?.(url, init);
        for await (const chunk of init.body) void chunk;
        return { ok: true, status: 200 };
      }
      const body = JSON.parse(init.body);
      const name = body.params.name;
      options.calls?.push(name);
      if (name === "prepare_demo_upload") {
        preparedFiles = body.params.arguments.files;
        options.onPrepare?.(body.params.arguments);
        await options.afterPrepare?.();
      }
      const resultBody =
        name === "check_connection"
          ? { expiresAt: "2026-10-01T00:00:00.000Z", user: "Publisher" }
          : name === "prepare_demo_upload"
            ? {
                project_id: "abc12",
                status: "prepared",
                upload_id: "d290f1ee-6c54-4b01-90e6-d701748f0851",
                uploads: preparedFiles.map((file) => ({
                  relative_path: file.relative_path,
                  upload_headers: {
                    "content-length": String(file.size),
                    "content-md5": file.content_md5,
                    "content-type": file.mime_type,
                  },
                  upload_url: `https://storage.test/${file.relative_path}`,
                })),
              }
            : name === "get_demo_upload_status"
              ? {
                  project_id: "abc12",
                  status: "completed",
                  upload_id: "d290f1ee-6c54-4b01-90e6-d701748f0851",
                }
              : {
                  project_id: "abc12",
                  status: "processing",
                  upload_id: "d290f1ee-6c54-4b01-90e6-d701748f0851",
                };
      return {
        json: async () => ({
          result: { content: [{ text: JSON.stringify(resultBody), type: "text" }] },
        }),
        ok: true,
        status: 200,
      };
    },
    sleep: async () => undefined,
  };
}

export function publishInput(directory) {
  return {
    action: "create",
    demoUrl: "https://demo.example.test",
    displayName: "Smoke",
    mcpUrl: "https://app.example.test/mcp",
    publishDir: directory,
    targetHtml: "index.html",
    token: "token_not_logged",
  };
}
