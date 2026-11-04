import { responseCookies } from "./password-access-fixture.mjs";

// Exercise the existing anonymous app→demo check rather than assuming that the
// content gateway still redirects directly to the password page before Phase 18.
export async function anonymousPasswordResponse(harness, https, response, path, method, check) {
  const location = new URL(response.headers.location, harness.demoUrl);
  if (location.pathname !== "/auth/session-handoff/start") return response;
  check(
    location.origin === new URL(harness.mcpUrl).origin,
    "anonymous check stays on the configured app origin",
  );
  check(
    response.body.length === 0 && !response.headers.etag,
    "anonymous check exposes no content metadata",
  );
  const probe = await fetch(location, { redirect: "manual" });
  check(probe.status === 302, "anonymous app check returns to the content origin");
  const completionUrl = new URL(probe.headers.get("location"));
  check(
    completionUrl.origin === harness.demoUrl,
    "anonymous completion stays on the configured demo origin",
  );
  check(
    !completionUrl.searchParams.has("ticket"),
    "anonymous app check creates no organization ticket",
  );
  const completed = await https.request(completionUrl.pathname + completionUrl.search);
  const returned = new URL(completed.headers.location, harness.demoUrl);
  check(
    completed.status === 302 &&
      returned.origin === harness.demoUrl &&
      returned.pathname + returned.search === path,
    "anonymous check preserves the exact return path",
  );
  return https.request(path, { method, headers: { cookie: responseCookies(completed) } });
}
