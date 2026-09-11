import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const uploadId = "d290f1ee-6c54-4b01-90e6-d701748f0851";
export const clientRequestId = "13baa609-ea42-4c66-a934-381685dc20ec";
export async function fixture(targetHtml = "index.html") {
  const directory = await mkdtemp(join(tmpdir(), "html-share-password-skill-"));
  await mkdir(dirname(join(directory, targetHtml)), { recursive: true });
  await writeFile(join(directory, targetHtml), "<h1>password test</h1>");
  return {
    directory,
    cleanup: () => rm(directory, { force: true, recursive: true }),
    input: {
      action: "create",
      publishDir: directory,
      targetHtml,
      displayName: "Password test",
      demoUrl: "https://demo.example.test",
      mcpUrl: "https://app.example.test/mcp",
      token: "token_never_logged",
      clientRequestId,
    },
  };
}

export function passwordHarness(options = {}) {
  const prepares = [];
  const calls = [];
  let putCount = 0;
  const final = {
    project_id: "abc12",
    upload_id: uploadId,
    status: "completed",
    access_mode: "password",
    access_password: "Abcd2345",
    password_status: "generated",
    target_url: "https://demo.example.test/abc12/index.html",
    ...options.result,
  };
  function response(value, isError = false) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        result: { isError, content: [{ type: "text", text: JSON.stringify(value) }] },
      }),
    };
  }
  return {
    prepares,
    calls,
    sleep: async () => undefined,
    request: async (url, init) => {
      if (String(url).startsWith("https://storage.test/")) {
        putCount += 1;
        for await (const chunk of init.body) void chunk;
        return {
          ok: !options.failPut && (!options.retryPut || putCount > 2),
          status: putCount > 2 ? 200 : 503,
        };
      }
      const body = JSON.parse(init.body);
      if (body.method === "tools/list") {
        calls.push("tools/list");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: {
              tools: [
                {
                  name: "prepare_demo_upload",
                  inputSchema: {
                    properties: options.oldSchema
                      ? {}
                      : { access_mode: {}, regenerate_password: {} },
                  },
                },
              ],
            },
          }),
        };
      }
      const name = body.params.name;
      calls.push(name);
      if (options.timeoutTool === name)
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("Simulated lost response")));
        });
      if (options.errorTool === name)
        return response(
          options.errorValue ?? { message: "access_password=Abcd2345 token_never_logged" },
          true,
        );
      if (name === "check_connection") return response({ user: "publisher" });
      if (name === "prepare_demo_upload") {
        prepares.push(body.params.arguments);
        if (options.retryPrepare && prepares.length === 1) return { ok: false, status: 503 };
        return response({
          project_id: "abc12",
          upload_id: uploadId,
          status: "prepared",
          uploads: body.params.arguments.files.map((file) => ({
            relative_path: file.relative_path,
            upload_headers: { "content-md5": file.content_md5 },
            upload_url: `https://storage.test/${file.relative_path}`,
          })),
        });
      }
      if (name === "complete_demo_upload") return response({ status: "processing" });
      return response(final);
    },
  };
}
