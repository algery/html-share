export async function verifyMainPassword({ published, project, env, h, secrets, check }) {
  // Exercise the real main behind its configured trusted loopback proxy boundary.
  // Transport-level HTTPS is covered separately by the HTTPS/proxy acceptance scripts.
  const target = new URL(published.target_url).pathname;
  // Node 24 fetch derives Host from the URL; use the trusted proxy's forwarded host.
  const headers = { "x-forwarded-host": "demo.localhost", "x-forwarded-proto": "https" };
  const page = await fetch(
    `http://127.0.0.1:55101/auth/password?return_path=${encodeURIComponent(target)}`,
    { headers, signal: AbortSignal.timeout(10000) },
  );
  check(page.status === 200, `server main serves password entry (${page.status})`);
  const state = (await page.text()).match(/"state":"([A-Za-z0-9_.-]+)"/)?.[1];
  const browserCookie = page.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  check(state && browserCookie, "server main issues signed browser-bound state");
  secrets.push(state, browserCookie.split("=", 2)[1]);
  const verified = await fetch("http://127.0.0.1:55101/auth/password/verify", {
    method: "POST",
    headers: {
      ...headers,
      origin: env.DEMO_WEB_URL,
      cookie: browserCookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ state, password: published.access_password }),
    signal: AbortSignal.timeout(10000),
  });
  check(
    verified.status === 200 && (await verified.json()).redirectUrl === target,
    "server main verifies worker password and returns exact path",
  );
  const grantCookie = verified.headers
    .getSetCookie()
    .find((value) => value.startsWith(`__Host-html_share_password_${project.projectKey}=`));
  check(
    grantCookie && grantCookie.includes("Secure") && grantCookie.includes("HttpOnly"),
    "real server grant cookie is Secure and HttpOnly",
  );
  secrets.push(grantCookie.split(";", 1)[0].split("=", 2)[1]);
  check(
    (await h.prisma.passwordAccessGrant.count({ where: { projectId: project.id } })) === 1,
    "real server persists one grant",
  );
}
