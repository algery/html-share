import { WEB_HEALTH } from "../../../lib/health";

export function GET(): Response {
  return Response.json(WEB_HEALTH, {
    headers: {
      "cache-control": "no-store",
    },
  });
}
