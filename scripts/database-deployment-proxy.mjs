import { connect, createServer } from "node:net";

/** Dedicated test proxy permits transport outages without stopping a shared database container. */
export async function createDatabaseTestProxy(environment) {
  const target = new URL(environment.DATABASE_URL);
  const upstream = { host: target.hostname, port: Number(target.port) };
  const sockets = new Set();
  const server = createServer((incoming) => {
    const outgoing = connect(upstream);
    sockets.add(incoming);
    sockets.add(outgoing);
    incoming.on("close", () => {
      sockets.delete(incoming);
      outgoing.destroy();
    });
    outgoing.on("close", () => {
      sockets.delete(outgoing);
      incoming.destroy();
    });
    incoming.on("error", () => outgoing.destroy());
    outgoing.on("error", () => incoming.destroy());
    incoming.pipe(outgoing).pipe(incoming);
  });
  let port = 0;
  async function resume() {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    port = server.address().port;
  }
  async function pause() {
    for (const socket of sockets) socket.destroy();
    if (server.listening)
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }
  await resume();
  target.hostname = "127.0.0.1";
  target.port = String(port);
  if (environment.DATABASE_PROVIDER === "mysql") {
    target.searchParams.set("connectionLimit", "1");
    target.searchParams.set("minimumIdle", "1");
    target.searchParams.set("connectTimeout", "1000");
    target.searchParams.set("acquireTimeout", "3000");
  }
  return { environment: { ...environment, DATABASE_URL: target.toString() }, pause, resume };
}
