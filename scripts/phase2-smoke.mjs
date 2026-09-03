const appUrl = "http://app.localhost:3001";
const demoUrl = "http://demo.localhost:3001";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readCookie(response) {
  const header = response.headers.get("set-cookie");
  assert(header !== null, "expected a session cookie");
  assert(header.includes("HttpOnly"), "cookie must be HttpOnly");
  assert(header.includes("Secure"), "cookie must be Secure");
  assert(header.includes("SameSite=Lax"), "cookie must be SameSite=Lax");
  assert(!header.includes("Domain="), "cookie must be Host-only");
  return header.split(";", 1)[0];
}

async function request(url, init = {}) {
  return fetch(url, { ...init, redirect: "manual" });
}

const appStart = await request(`${appUrl}/auth/login?return_path=/login`);
assert(appStart.status === 302, "external app authorization must start with a redirect");
const appCallback = appStart.headers.get("location");
assert(appCallback !== null, "external app callback must be present");
const appComplete = await request(appCallback);
assert(appComplete.status === 302, "external app authorization must complete with a redirect");
assert(
  appComplete.headers.get("location") === "http://app.localhost:3000/login",
  "app return path must be preserved",
);
const appCookie = readCookie(appComplete);

const appCurrent = await request(`${appUrl}/auth/current`, { headers: { cookie: appCookie } });
assert(appCurrent.status === 200, "app session must access app current-user endpoint");
const demoWithAppCookie = await request(`${demoUrl}/auth/content`, {
  headers: { cookie: appCookie },
});
assert(demoWithAppCookie.status === 401, "app cookie must not authorize demo content");

const demoStart = await request(`${demoUrl}/auth/internal/start`, {
  body: JSON.stringify({ returnPath: "/3h32g/a.html" }),
  headers: { "content-type": "application/json" },
  method: "POST",
});
assert(demoStart.status === 200, "internal demo authorization must start");
const { state } = await demoStart.json();
assert(
  typeof state === "string" && state.length > 0,
  "internal demo authorization must return state",
);
const demoComplete = await request(`${demoUrl}/auth/internal/complete`, {
  body: JSON.stringify({ code: "simulator-member", state }),
  headers: { "content-type": "application/json" },
  method: "POST",
});
assert(demoComplete.status === 302, "internal demo authorization must complete with a redirect");
assert(
  demoComplete.headers.get("location") === "http://demo.localhost:3001/3h32g/a.html",
  "demo return path must be preserved exactly",
);
const demoCookie = readCookie(demoComplete);

const demoAuthorized = await request(`${demoUrl}/auth/content`, {
  headers: { cookie: demoCookie },
});
assert(demoAuthorized.status === 200, "demo session must authorize demo content entry");
const appWithDemoCookie = await request(`${appUrl}/auth/current`, {
  headers: { cookie: demoCookie },
});
assert(appWithDemoCookie.status === 401, "demo cookie must not authorize app API");

const demoLogout = await request(`${demoUrl}/auth/logout`, {
  headers: { cookie: demoCookie },
  method: "POST",
});
assert(demoLogout.status === 204, "logout must succeed");
const demoAfterLogout = await request(`${demoUrl}/auth/content`, {
  headers: { cookie: demoCookie },
});
assert(demoAfterLogout.status === 401, "logout must revoke the demo session");

console.log(
  "Phase 2 smoke check passed: app external auth, demo internal auth, isolation, exact return path, and logout.",
);
