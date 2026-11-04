import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";

/** Use native HTTP so the configured virtual-host header survives Node 24. */
export function httpIsHealthy(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const get = new URL(url).protocol === "https:" ? httpsGet : httpGet;
    const request = get(url, { headers }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    request.setTimeout(1_500, () => request.destroy(new Error("Health request timed out")));
    request.once("error", reject);
  });
}
