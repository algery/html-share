import { request } from "node:http";

// Node 24 fetch ignores Host overrides. The image test needs separate app/demo
// hosts while connecting only to its fixed loopback port.
export function imageRequest(path, options = {}, domain = "app") {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port: 55531,
        path,
        method: options.method ?? "GET",
        headers: { host: `${domain}.localhost`, ...options.headers },
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.once("error", reject);
        incoming.once("end", () => {
          const headers = new globalThis.Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2)
            headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
          const status = incoming.statusCode;
          resolve(
            new globalThis.Response(
              [204, 304].includes(status) || options.method === "HEAD"
                ? null
                : Buffer.concat(chunks),
              { status, headers },
            ),
          );
        });
      },
    );
    outgoing.setTimeout(15_000, () => outgoing.destroy(new Error("Isolated image HTTP timeout")));
    outgoing.once("error", reject);
    outgoing.end(options.body);
  });
}
