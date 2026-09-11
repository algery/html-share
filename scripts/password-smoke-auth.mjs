import { randomBytes, randomUUID } from "node:crypto";

import * as core from "../packages/core/dist/index.js";
import * as db from "../packages/db/dist/index.js";

export async function createSmokeAuthorization({ appKey, check, prisma, states }) {
  const authRepository = db.createAuthRepository(prisma);
  const sessions = core.createAuthSessionService({
    repository: {
      ...authRepository,
      async createAuthState(input) {
        states.push(input.stateDigest);
        await authRepository.createAuthState(input);
      },
    },
    stateSecret: randomBytes(32).toString("base64"),
    tenantAppKeyRef: appKey,
  });
  const identity = {
    dingtalkUserId: randomUUID(),
    displayName: "Smoke publisher",
  };
  const state = await sessions.beginAuthorization({
    audience: "demo",
    returnPath: "/abc12/index.html",
  });
  const authorization = await sessions.finishAuthorization({
    audience: "demo",
    state: state.state,
    identity,
  });
  const session = await sessions.getSession({ audience: "demo", token: authorization.token });
  check(session !== null, "real organization content session created");
  const appState = await sessions.beginAuthorization({ audience: "app", returnPath: "/demos" });
  const appAuthorization = await sessions.finishAuthorization({
    audience: "app",
    state: appState.state,
    identity,
  });
  const appSession = await sessions.getSession({
    audience: "app",
    token: appAuthorization.token,
  });
  check(appSession?.user.id === session.user.id, "real app session shares the publisher identity");
  return { appAuthorization, authorization, session, sessions };
}
