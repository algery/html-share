import { MAX_IMAGE_BYTES, VIEWPORT } from "./bundle.mjs";

const origin = "https://square-render.invalid";
const csp = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:",
  "style-src 'self' 'unsafe-inline' blob: data:",
  "connect-src 'self' blob: data:",
  "form-action 'none'",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

export async function captureCover(chromium, bundle, { executablePath } = {}) {
  const browser = await chromium.launch({
    chromiumSandbox: true,
    timeout: 8_000,
    ...(executablePath ? { executablePath } : {}),
  });
  const deadline = setTimeout(() => void browser.close().catch(() => {}), 18_000);
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    let criticalResourceMissing = false;
    await context.exposeBinding("reportMissingCoverResource", () => {
      criticalResourceMissing = true;
    });
    await context.addInitScript(() => {
      globalThis.addEventListener("securitypolicyviolation", (event) => {
        if (
          /^(script-src|style-src|connect-src|img-src|frame-src|child-src|base-uri|media-src|font-src|default-src)/.test(
            event.effectiveDirective,
          ) &&
          /^(https?|wss?):/.test(event.blockedURI)
        )
          void globalThis.reportMissingCoverResource();
      });
    });
    const prefix = `/${bundle.projectKey}/`;
    await context.routeWebSocket("**/*", (socket) => {
      criticalResourceMissing = true;
      socket.close();
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const critical = [
        "document",
        "script",
        "stylesheet",
        "xhr",
        "fetch",
        "image",
        "media",
        "font",
      ].includes(request.resourceType());
      if (url.origin !== origin || !["GET", "HEAD"].includes(request.method())) {
        criticalResourceMissing ||= critical;
        await route.abort();
        return;
      }

      if (!url.pathname.startsWith(prefix) || /%(?:2f|5c)/i.test(url.pathname)) {
        criticalResourceMissing ||= critical;
        await route.fulfill({ status: 404, body: "" });
        return;
      }

      let path;
      try {
        path = decodeURIComponent(url.pathname.slice(prefix.length));
      } catch {
        await route.abort();
        return;
      }

      const file = bundle.files.get(path);
      if (!file) {
        criticalResourceMissing ||= critical;
        await route.fulfill({ status: 404, body: "" });
        return;
      }
      await route.fulfill({
        status: 200,
        body: request.method() === "HEAD" ? Buffer.alloc(0) : file.body,
        contentType: file.mimeType,
        headers: { "content-security-policy": csp, "x-content-type-options": "nosniff" },
      });
    });

    const page = await context.newPage();
    page.on("popup", (popup) => void popup.close().catch(() => {}));
    const url = `${origin}${prefix}${bundle.homepage.split("/").map(encodeURIComponent).join("/")}`;
    const response = await page.goto(url, { waitUntil: "load", timeout: 12_000 });
    if (!response?.ok() || page.url() !== url) throw new Error("INVALID_HOMEPAGE");
    const image = await page.screenshot({
      type: "jpeg",
      quality: 78,
      animations: "disabled",
      caret: "hide",
      timeout: 5_000,
    });
    if (page.url() !== url || image.length > MAX_IMAGE_BYTES || criticalResourceMissing)
      throw new Error("INVALID_SCREENSHOT");
    return image;
  } finally {
    clearTimeout(deadline);
    await browser.close();
  }
}
