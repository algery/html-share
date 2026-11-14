import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { createFeishuClient } from "../apps/server/dist/modules/auth/feishu-client.js";

// A loopback-only provider exercises the production OAuth parser and PKCE request.
export async function feishuOAuthFixture() {
  const codes = new Map();
  let outcome = "success";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1:55120");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/authorize") {
      const callback = new URL(url.searchParams.get("redirect_uri"));
      if (!["http://127.0.0.1:55100", "http://localhost:55100"].includes(callback.origin)) {
        res.writeHead(400);
        res.end("{}");
        return;
      }
      callback.searchParams.set("state", url.searchParams.get("state"));
      if (outcome === "cancel") callback.searchParams.set("error", "access_denied");
      else {
        const code = randomUUID();
        codes.set(code, {
          challenge: url.searchParams.get("code_challenge"),
          callback: url.searchParams.get("redirect_uri"),
          outcome,
        });
        callback.searchParams.set("code", code);
      }
      res.writeHead(302, { location: callback.toString() });
      res.end();
      return;
    }
    if (url.pathname === "/oauth/v3/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body);
      const record = codes.get(data.code);
      codes.delete(data.code);
      if (
        !record ||
        record.callback !== data.redirect_uri ||
        data.client_id !== "cli_browser" ||
        data.client_secret !== "synthetic-browser-secret" ||
        createHash("sha256")
          .update(data.code_verifier ?? "")
          .digest("base64url") !== record.challenge
      ) {
        res.writeHead(400);
        res.end(JSON.stringify({ code: 1 }));
        return;
      }
      res.end(
        JSON.stringify({
          code: 0,
          access_token: `test-${record.outcome}`,
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );
      return;
    }
    if (url.pathname === "/open-apis/authen/v1/user_info") {
      const foreign = req.headers.authorization === "Bearer test-foreign";
      res.end(
        JSON.stringify({
          code: 0,
          data: {
            open_id: "browser-open",
            tenant_key: foreign ? "foreign" : "browser-tenant",
            name: "浏览器飞书成员",
            email: "member@example.com",
          },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(55120, "127.0.0.1", resolve));
  const live = createFeishuClient({
    appId: "cli_browser",
    appSecret: "synthetic-browser-secret",
    tenantKey: "browser-tenant",
    fetcher: (url, init) => fetch(new URL(new URL(url).pathname, "http://127.0.0.1:55120"), init),
  });
  return {
    client: {
      ...live,
      createAuthorizationUrl(input) {
        const official = new URL(live.createAuthorizationUrl(input));
        return `http://127.0.0.1:55120/authorize${official.search}`;
      },
    },
    outcome(value) {
      outcome = value;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
