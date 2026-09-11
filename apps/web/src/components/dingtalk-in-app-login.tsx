"use client";

import { useEffect, useState } from "react";

import {
  completeDingTalkInAppLogin,
  readDingTalkBridge,
  type DingTalkInAppDiagnostic,
} from "../lib/dingtalk-in-app";

interface DingTalkInAppLoginProps {
  apiUrl: string;
  clientId?: string | undefined;
  corpId?: string | undefined;
  returnPath: string;
}

export function DingTalkInAppLogin({
  apiUrl,
  clientId,
  corpId,
  returnPath,
}: DingTalkInAppLoginProps) {
  const [status, setStatus] = useState<"idle" | "verifying" | "error">("idle");

  useEffect(() => {
    const bridge = readDingTalkBridge(window.dd);
    if (bridge === null) {
      printDiagnostic({
        outcome: "failed",
        stage: "auth_code_request",
      });
      return;
    }

    void Promise.resolve()
      .then(() => {
        setStatus("verifying");
        return completeDingTalkInAppLogin({
          apiUrl,
          bridge,
          clientId,
          corpId,
          fetcher: (input, init) => fetch(input, { ...init, credentials: "include" }),
          reportDiagnostic: printDiagnostic,
          returnPath,
        });
      })
      .then(
        (redirectUrl) => window.location.assign(redirectUrl),
        () => setStatus("error"),
      );
  }, [apiUrl, clientId, corpId, returnPath]);

  if (status === "verifying") {
    return <p aria-live="polite">正在通过钉钉免登验证身份…</p>;
  }
  if (status === "error") {
    return <p aria-live="polite">钉钉免登未完成，请使用下方授权入口重试。</p>;
  }
  return null;
}

function printDiagnostic(diagnostic: DingTalkInAppDiagnostic) {
  // Deliberately log only fixed stage/result fields. Authorization codes and state never enter it.
  console.info("[html-share:dingtalk-auth]", diagnostic);
}
