import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const origin = "https://cover-render.invalid";
const csp = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:",
  "style-src 'self' 'unsafe-inline' blob: data:",
  "connect-src 'self' blob: data:",
  "frame-src 'self' blob: data:",
  "form-action 'none'",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");
const criticalResources = new Set([
  "document",
  "script",
  "stylesheet",
  "xhr",
  "fetch",
  "image",
  "media",
  "font",
]);

process.once("message", async (bundle) => {
  try {
    const { chromium } = require(bundle.playwright);
    const image = await render(chromium, bundle);
    process.send(image, () => process.disconnect());
  } catch {
    process.exitCode = 1;
    process.disconnect();
  }
});

async function render(chromium, { projectId, homepage, assets }) {
  const browser = await chromium.launch({
    chromiumSandbox: true,
    timeout: 4_000,
    // Deny network fallback for traffic that does not pass through Playwright routing.
    args: [
      "--proxy-server=http://blocked.invalid:9",
      "--proxy-bypass-list=<-loopback>",
      "--host-resolver-rules=MAP * ~NOTFOUND",
      "--dns-prefetch-disable",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--disable-quic",
    ],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 960, height: 600 },
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    let resourceMissing = false;
    await context.exposeBinding("reportMissingCoverResource", () => {
      resourceMissing = true;
    });
    await context.addInitScript(() => {
      globalThis.addEventListener("securitypolicyviolation", (event) => {
        if (
          /^(script-src|style-src|connect-src|img-src|frame-src|child-src|base-uri|media-src|font-src|default-src)/.test(
            event.effectiveDirective,
          ) &&
          /^(https?|wss?):/.test(event.blockedURI)
        ) {
          void globalThis.reportMissingCoverResource();
        }
      });
    });
    await context.routeWebSocket("**/*", (socket) => {
      resourceMissing = true;
      return socket.close();
    });
    const prefix = `/${projectId}/`;
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin || !["GET", "HEAD"].includes(request.method())) {
        resourceMissing ||= criticalResources.has(request.resourceType());
        await route.abort();
        return;
      }
      const path = assetPath(url, prefix);
      const file = assets.get(path);
      if (file === undefined) {
        resourceMissing ||= criticalResources.has(request.resourceType());
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
    const url = `${origin}${prefix}${homepage.split("/").map(encodeURIComponent).join("/")}`;
    const response = await page.goto(url, { waitUntil: "load", timeout: 5_000 });
    if (!response?.ok() || page.url() !== url || resourceMissing)
      throw new Error("INVALID_HOMEPAGE");
    const image = await page.screenshot({
      type: "jpeg",
      quality: 78,
      animations: "disabled",
      caret: "hide",
      timeout: 2_000,
    });
    if (page.url() !== url || resourceMissing) throw new Error("INVALID_SCREENSHOT");
    return image;
  } finally {
    await browser.close();
  }
}

function assetPath(url, prefix) {
  if (!url.pathname.startsWith(prefix) || /%(?:2f|5c)/i.test(url.pathname)) return null;
  try {
    return decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    return null;
  }
}
