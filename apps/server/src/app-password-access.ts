import type { FastifyInstance } from "fastify";
import type { ServerAppOptions } from "./app.js";
import { readSessionCookie } from "./modules/auth/cookies.js";
import { registerPasswordRoutes } from "./modules/content/password-routes.js";
import {
  readPasswordAccessCookie,
  usesSecurePasswordCookie,
} from "./modules/content/password-cookies.js";

export function registerPasswordAccess(app: FastifyInstance, options: ServerAppOptions) {
  const { passwordAccess, passwordStateSecret } = options;
  if (passwordAccess === undefined && passwordStateSecret === undefined) return;
  if (passwordAccess === undefined || passwordStateSecret === undefined)
    throw new Error("Password access requires its service and state secret");
  const secureCookie = usesSecurePasswordCookie(options.demoWebUrl);
  registerPasswordRoutes(app, {
    demoHost: options.demoHost,
    feishuEnabled: options.feishu !== undefined,
    demoWebUrl: options.demoWebUrl,
    passwordAccess,
    stateSecret: passwordStateSecret,
    ...(options.passwordRateLimits === undefined ? {} : { rateLimits: options.passwordRateLimits }),
    async isAuthorized(request, path) {
      const session = await options.authSessions.getSession({
        audience: "demo",
        token: readSessionCookie(request, "demo"),
      });
      const token = readPasswordAccessCookie(request, path.projectKey, secureCookie);
      return (
        (await passwordAccess.authorize({
          ...path,
          ...(session === null ? {} : { tenantId: session.tenantId }),
          ...(token === undefined ? {} : { token }),
        })) !== null
      );
    },
  });
}
