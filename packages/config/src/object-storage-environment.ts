import { URL } from "node:url";

import { z } from "zod";

export function validateObjectStorageEnvironment(
  context: z.core.$RefinementCtx,
  value: {
    OBJECT_STORAGE_ENDPOINT: string;
    OBJECT_STORAGE_PROVIDER: "minio" | "oss" | "r2";
    OBJECT_STORAGE_PUBLIC_ENDPOINT?: string | undefined;
    OBJECT_STORAGE_REGION: string;
  },
) {
  if (value.OBJECT_STORAGE_PROVIDER !== "r2") return;

  const endpointIdentity = readR2S3EndpointIdentity(value.OBJECT_STORAGE_ENDPOINT);
  if (endpointIdentity === null) {
    context.addIssue({
      code: "custom",
      message: "R2 must use an official HTTPS S3 API endpoint",
      path: ["OBJECT_STORAGE_ENDPOINT"],
    });
  }
  if (value.OBJECT_STORAGE_PUBLIC_ENDPOINT !== undefined) {
    const publicEndpointIdentity = readR2S3EndpointIdentity(value.OBJECT_STORAGE_PUBLIC_ENDPOINT);
    if (publicEndpointIdentity === null) {
      context.addIssue({
        code: "custom",
        message: "R2 must use an official HTTPS S3 API endpoint",
        path: ["OBJECT_STORAGE_PUBLIC_ENDPOINT"],
      });
    } else if (
      endpointIdentity !== null &&
      (publicEndpointIdentity.accountId !== endpointIdentity.accountId ||
        publicEndpointIdentity.jurisdiction !== endpointIdentity.jurisdiction)
    ) {
      context.addIssue({
        code: "custom",
        message: "R2 endpoints must use the same account and jurisdiction",
        path: ["OBJECT_STORAGE_PUBLIC_ENDPOINT"],
      });
    }
  }
  if (value.OBJECT_STORAGE_REGION !== "auto") {
    context.addIssue({
      code: "custom",
      message: "R2 region must be auto",
      path: ["OBJECT_STORAGE_REGION"],
    });
  }
}

function readR2S3EndpointIdentity(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }

  const match =
    /^(?<accountId>[a-f0-9]{32})\.(?:(?<jurisdiction>us|eu|fedramp)\.)?r2\.cloudflarestorage\.com$/i.exec(
      url.hostname,
    );
  if (match?.groups === undefined) return null;
  const accountId = match.groups["accountId"];
  if (accountId === undefined) return null;
  return {
    accountId: accountId.toLowerCase(),
    jurisdiction: match.groups["jurisdiction"]?.toLowerCase() ?? "default",
  };
}
