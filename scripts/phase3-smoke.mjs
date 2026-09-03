const appUrl = "http://app.localhost:3001";
const appWebUrl = "http://app.localhost:3000";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(url, init = {}) {
  return fetch(url, { ...init, redirect: "manual" });
}

async function createAppSession() {
  const login = await request(`${appUrl}/auth/login?return_path=/tokens`);
  assert(login.status === 302, "app authorization must start with a redirect");
  const callback = login.headers.get("location");
  assert(callback !== null, "app authorization callback must be present");
  const completed = await request(callback);
  assert(completed.status === 302, "app authorization must complete with a redirect");
  const cookie = completed.headers.get("set-cookie");
  assert(cookie !== null, "app session cookie must be present");
  return cookie.split(";", 1)[0];
}

const appCookie = await createAppSession();
const created = await request(`${appUrl}/api/tokens`, {
  body: JSON.stringify({ name: "Phase 3 smoke" }),
  headers: {
    cookie: appCookie,
    "content-type": "application/json",
    origin: appWebUrl,
  },
  method: "POST",
});
assert(created.status === 201, "Token creation must succeed for an app session");
assert(created.headers.get("cache-control") === "no-store", "Token response must not be cacheable");
const createdBody = await created.json();
assert(typeof createdBody.value === "string", "Token plaintext must be returned once");
assert(/^hsp_[A-Za-z0-9_-]{43}$/.test(createdBody.value), "Token format must be valid");

const listed = await request(`${appUrl}/api/tokens`, {
  headers: { cookie: appCookie },
});
assert(listed.status === 200, "Token list must be available to its owner");
const listedBody = await listed.json();
assert(!JSON.stringify(listedBody).includes(createdBody.value), "Token list must hide plaintext");

const legacyInitialize = await request(`${appUrl}/mcp`, {
  body: JSON.stringify({
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "phase3-smoke", version: "1.0.0" },
      protocolVersion: "2025-11-25",
    },
  }),
  headers: {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${createdBody.value}`,
    "content-type": "application/json",
    "mcp-protocol-version": "2025-11-25",
  },
  method: "POST",
});
assert(legacyInitialize.status === 200, "MCP must accept a 2025-era initialize request");
const initializeBody = await legacyInitialize.json();
assert(
  initializeBody?.result?.protocolVersion === "2025-11-25",
  "MCP must negotiate the requested supported protocol version",
);

const afterUse = await request(`${appUrl}/api/tokens`, { headers: { cookie: appCookie } });
const afterUseBody = await afterUse.json();
assert(afterUseBody.tokens[0]?.lastUsedAt !== null, "Successful MCP use must update lastUsedAt");

const rejectedQuery = await request(`${appUrl}/mcp?token=not-allowed`, {
  headers: { authorization: `Bearer ${createdBody.value}` },
  method: "POST",
});
assert(rejectedQuery.status === 401, "Query-string MCP credentials must be rejected");

const revoked = await request(`${appUrl}/api/tokens/${createdBody.token.id}/revoke`, {
  headers: { cookie: appCookie, origin: appWebUrl },
  method: "POST",
});
assert(revoked.status === 204, "Token owner must be able to revoke a token");

const afterRevoke = await request(`${appUrl}/mcp`, {
  headers: { authorization: `Bearer ${createdBody.value}` },
  method: "POST",
});
assert(afterRevoke.status === 401, "Revoked Token must be rejected immediately");

console.log(
  "Phase 3 smoke check passed: one-time token, 2025 MCP, last use, query rejection, revoke.",
);
