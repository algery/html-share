import { createDirectoryService } from "@html-share/core";
import type { readDingTalkEnv } from "@html-share/config";
import {
  createDisabledDirectoryProvider,
  createLiveDirectoryProvider,
  createSimulatorDirectoryProvider,
} from "@html-share/dingtalk";

export function buildDirectoryService(environment: ReturnType<typeof readDingTalkEnv>) {
  const corpId = environment.DINGTALK_CORP_ID ?? "simulator-corp";
  const provider =
    environment.DINGTALK_AUTH_MODE === "simulator"
      ? createSimulatorDirectoryProvider()
      : !environment.DINGTALK_DIRECTORY_ENABLED
        ? createDisabledDirectoryProvider()
        : createLiveDirectoryProvider({
            corpId,
            contactApiBaseUrl: environment.DINGTALK_CONTACT_API_BASE_URL,
            clientId: environment.DINGTALK_CLIENT_ID,
            clientSecret: environment.DINGTALK_CLIENT_SECRET,
          });
  return createDirectoryService(provider, { corpId });
}
