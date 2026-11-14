import { clearPasswordReturn, redirectPasswordFailure } from "./password-return.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AccountLinkError, AuthenticationError, type SessionAudience } from "@html-share/core";
import {
  DingTalkAuthorizationError,
  type DingTalkAuthorizationDiagnostic,
} from "@html-share/dingtalk";
import type { AuthRouteOptions } from "./routes.js";
import { setSessionCookie, usesSecureSessionCookie } from "./cookies.js";
import { logAuthorizationStep } from "./dingtalk-logging.js";
import { redirectToAudience } from "./return-state.js";
import { sendContentAuthorizationError } from "../content/error-pages.js";
import { usesSecurePasswordCookie } from "../content/password-cookies.js";

export async function completeAuthorization(input: {
  audience: SessionAudience;
  code: string;
  contentLogin?: boolean;
  internal: boolean;
  options: AuthRouteOptions;
  reply: FastifyReply;
  request: FastifyRequest;
  state: string;
}) {
  const authFlow = input.internal ? "internal" : "external";
  logAuthorizationStep(input.request.log, input.request.traceId, {
    audience: input.audience,
    authFlow,
    outcome: "started",
    stage: "callback_received",
  });
  const reportDiagnostic = (diagnostic: DingTalkAuthorizationDiagnostic) => {
    logAuthorizationStep(input.request.log, input.request.traceId, {
      audience: input.audience,
      authFlow,
      ...diagnostic,
    });
  };
  try {
    const identity = input.internal
      ? await input.options.dingtalk.exchangeInternalAuthorizationCode(input.code, reportDiagnostic)
      : await input.options.dingtalk.exchangeExternalAuthorizationCode(
          input.code,
          reportDiagnostic,
        );
    logAuthorizationStep(input.request.log, input.request.traceId, {
      audience: input.audience,
      authFlow,
      outcome: "succeeded",
      stage: "identity_resolved",
    });
    const authorization = await input.options.sessions.finishAuthorization({
      audience: input.audience,
      identity,
      state: input.state,
    });
    const authUrl = input.audience === "app" ? input.options.appAuthUrl : input.options.demoAuthUrl;
    setSessionCookie(input.reply, {
      ...authorization,
      secure: usesSecureSessionCookie(authUrl),
    });
    logAuthorizationStep(input.request.log, input.request.traceId, {
      audience: input.audience,
      authFlow,
      outcome: "succeeded",
      stage: "session_created",
    });
    if (input.audience === "demo" && input.options.passwordAccess !== undefined)
      clearPasswordReturn(
        input.reply,
        input.state,
        usesSecurePasswordCookie(input.options.demoWebUrl),
      );
    const redirectUrl = redirectToAudience({
      appWebUrl: input.options.appWebUrl,
      audience: input.audience,
      demoWebUrl: input.options.demoWebUrl,
      returnPath: authorization.returnPath,
    });
    // The management in-app flow uses fetch, so return the target explicitly.
    // Browser fetch follows HTTP redirects and hides the original Location header.
    if (
      input.internal &&
      (input.audience === "app" || input.request.headers.accept === "application/json")
    )
      return { redirectUrl };
    return input.reply.redirect(redirectUrl);
  } catch (error) {
    if (
      (error instanceof AuthenticationError ||
        error instanceof DingTalkAuthorizationError ||
        error instanceof AccountLinkError) &&
      input.contentLogin &&
      (await redirectPasswordFailure(input.request, input.reply, input.options, input.state))
    ) {
      return input.reply;
    }
    if (error instanceof AccountLinkError) {
      const status = error.code === "ACCOUNT_LINK_CONFLICT" ? "account-conflict" : "denied";
      if (input.contentLogin)
        return sendContentAuthorizationError(
          input.reply,
          error.code === "ACCOUNT_LINK_CONFLICT"
            ? "ACCOUNT_LINK_CONFLICT"
            : "ORGANIZATION_ACCESS_DENIED",
        );
      return input.reply.redirect(
        new URL(`/login?status=${status}`, input.options.appWebUrl).toString(),
      );
    }
    if (error instanceof AuthenticationError) {
      logAuthorizationStep(input.request.log, input.request.traceId, {
        audience: input.audience,
        authFlow,
        failureType: "AUTH_STATE_INVALID",
        outcome: "failed",
        stage: "session_validation",
      });
      if (input.contentLogin)
        return sendContentAuthorizationError(input.reply, "AUTH_STATE_INVALID");
      return input.reply.code(400).send({ error: "invalid_auth_state" });
    }
    if (error instanceof DingTalkAuthorizationError) {
      logAuthorizationStep(input.request.log, input.request.traceId, {
        audience: input.audience,
        authFlow,
        ...(error.details?.failureReason === undefined
          ? {}
          : { failureReason: error.details.failureReason }),
        ...(error.details?.httpStatus === undefined
          ? {}
          : { httpStatus: error.details.httpStatus }),
        failureType: error.code,
        outcome: "failed",
        stage: "authorization_complete",
      });
      if (input.contentLogin) {
        return sendContentAuthorizationError(
          input.reply,
          error.code === "AUTHORIZATION_DENIED"
            ? "ORGANIZATION_ACCESS_DENIED"
            : "IDENTITY_PROVIDER_UNAVAILABLE",
        );
      }
      return input.reply.code(error.code === "AUTHORIZATION_DENIED" ? 403 : 502).send({
        error:
          error.code === "AUTHORIZATION_DENIED"
            ? "organization_access_denied"
            : "identity_provider_unavailable",
      });
    }
    throw error;
  }
}
