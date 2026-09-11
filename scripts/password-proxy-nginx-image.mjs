import { randomUUID } from "node:crypto";
import { command, PROXY_IMAGES } from "./password-proxy-runtime.mjs";

// Optional fallback, explicitly distinct from an OpenResty/1Panel runtime test.
const name = `html-share-password-proxy-nginx-build-${randomUUID().slice(0, 8)}`;
const base = "node:24-alpine";
const image = PROXY_IMAGES.nginx;
await command("docker", ["image", "inspect", base]);
let created = false;
try {
  await command("docker", [
    "create",
    "--name",
    name,
    "--label",
    "html-share-smoke=password-proxy",
    base,
    "sh",
    "-c",
    "apk add --no-cache nginx && nginx -v",
  ]);
  created = true;
  const installation = await command("docker", ["start", "--attach", name], 180_000);
  const inspected = JSON.parse((await command("docker", ["inspect", name])).stdout)[0];
  if (inspected.State.ExitCode !== 0) throw new Error("Official Alpine nginx installation failed");
  await command("docker", ["commit", name, image]);
  const result = JSON.parse((await command("docker", ["image", "inspect", image])).stdout)[0];
  console.log(
    JSON.stringify({
      status: "nginx-fallback-image-ready",
      image,
      imageId: result.Id,
      baseImageId: inspected.Image,
      validationScope: "nginx-compatibility-only",
      installation: (installation.stdout + installation.stderr).trim(),
    }),
  );
} finally {
  if (created) await command("docker", ["rm", "--force", name]);
}
