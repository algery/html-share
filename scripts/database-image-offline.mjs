/** Only the dedicated databases and MinIO are reachable on this internal network. */
export async function verifyOfflineImages({ docker, envArgs, server, worker, provider, names }) {
  const network = "html-share-phase26-offline";
  if ((await docker("network", "inspect", network, "--format", "{{.Internal}}")) !== "true")
    throw new Error("An internal-only image test network is required");
  const common = [
    "--network",
    network,
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--cap-drop",
    "ALL",
    "-v",
    "html-share-phase26-image-targets:/deployment-target",
  ];
  await docker(
    "run",
    "--rm",
    ...common,
    ...envArgs,
    server,
    "node",
    "/workspace/scripts/database-migrate.mjs",
  );
  await docker(
    "run",
    "--rm",
    ...common,
    ...envArgs,
    server,
    "node",
    "/workspace/scripts/database-deployment-preflight.mjs",
    "--write-target=/deployment-target/target.json",
  );
  const own = [];
  for (const [role, image] of [
    ["server", server],
    ["worker", worker],
  ]) {
    const name = `html-share-phase26-offline-${provider}-${role}`;
    names.push(name);
    own.push(name);
    await docker(
      "run",
      "-d",
      "--name",
      name,
      ...common,
      "--cpus=1",
      "--memory=768m",
      ...envArgs,
      image,
    );
  }
  for (const [index, port] of [
    [0, 3001],
    [1, 3002],
  ]) {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await docker(
          "exec",
          own[index],
          "node",
          "-e",
          `require('node:http').get('http://127.0.0.1:${port}/health/ready',{headers:{host:'app.localhost'}},r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))`,
        );
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!ready) throw new Error("Offline runtime did not become SQL-ready");
  }
  await docker("rm", "-f", ...own);
  for (const name of own) names.splice(names.indexOf(name), 1);
  return {
    internalNetwork: true,
    serverReady: true,
    workerReady: true,
    runtimeDownloadsBlocked: true,
  };
}
