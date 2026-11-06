import { DirectoryUnavailableError } from "@html-share/core";

import { record, textValue } from "./directory-values.js";

export interface LiveDirectoryProviderOptions {
  corpId: string;
  contactApiBaseUrl: string;
  clientId: string;
  clientSecret: string;
  fetcher?: typeof fetch;
}

export interface DirectoryApi {
  call(path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export function createDirectoryApi(options: LiveDirectoryProviderOptions): DirectoryApi {
  const fetcher = options.fetcher ?? fetch;
  let token: { value: string; expiresAt: number } | undefined;
  let tokenRequest: Promise<string> | undefined;
  if (!options.corpId.trim() || !options.clientId.trim() || !options.clientSecret.trim()) {
    throw new DirectoryUnavailableError("disabled");
  }

  async function request(url: URL, body?: Record<string, unknown>, parent?: AbortSignal) {
    return withDirectoryTimeout(
      10_000,
      async (signal) => {
        const response = await fetcher(url, {
          method: body === undefined ? "GET" : "POST",
          ...(body === undefined
            ? {}
            : {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
          signal,
        });
        if (!response.ok) throw new DirectoryUnavailableError("provider_rejected");
        const payload = record(await response.json());
        if (payload["errcode"] !== 0) {
          if (payload["errcode"] === 40014 || payload["errcode"] === 42001) token = undefined;
          throw new DirectoryUnavailableError("provider_rejected");
        }
        return payload;
      },
      parent,
    );
  }

  async function accessToken(signal?: AbortSignal): Promise<string> {
    if (token && token.expiresAt > Date.now()) return token.value;
    if (!tokenRequest) {
      tokenRequest = (async () => {
        const startedAt = Date.now();
        const url = new URL("/gettoken", options.contactApiBaseUrl);
        url.searchParams.set("appkey", options.clientId);
        url.searchParams.set("appsecret", options.clientSecret);
        const payload = await request(url, undefined, signal);
        const value = textValue(payload["access_token"]);
        const expiresIn = payload["expires_in"];
        if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
          throw new DirectoryUnavailableError("invalid_response");
        }
        token = { value, expiresAt: startedAt + Math.max(0, expiresIn * 1_000 - 30_000) };
        return value;
      })();
      void tokenRequest
        .finally(() => {
          tokenRequest = undefined;
        })
        .catch(() => undefined);
    }
    return tokenRequest;
  }

  return {
    async call(path, body, signal) {
      const access = await accessToken(signal);
      const url = new URL(path, options.contactApiBaseUrl);
      url.searchParams.set("access_token", access);
      const payload = await request(url, body, signal);
      return path === "/auth/scopes" ? payload : payload["result"];
    },
  };
}

export async function withDirectoryTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        abort = () => {
          controller.abort();
          reject(new DirectoryUnavailableError("timeout"));
        };
        timer = setTimeout(abort, timeoutMs);
        parent?.addEventListener("abort", abort, { once: true });
        if (parent?.aborted) abort();
      }),
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new DirectoryUnavailableError("timeout");
        return operation(controller.signal);
      }),
    ]);
  } catch (error) {
    if (error instanceof DirectoryUnavailableError) throw error;
    throw new DirectoryUnavailableError();
  } finally {
    clearTimeout(timer);
    if (abort) parent?.removeEventListener("abort", abort);
  }
}
