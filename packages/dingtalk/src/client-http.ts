const MAX_RESPONSE_BYTES = 64 * 1024;

/** Bound the entire request, including body streaming; never forward upstream exceptions. */
export async function requestAuthorizationJson(
  request: (signal: AbortSignal) => Promise<Response>,
): Promise<{ response: Response; payload: unknown }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("upstream_timeout"));
        }, 10_000);
      }),
      (async () => {
        const response = await request(controller.signal);
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          return { response, payload: undefined };
        }
        return { response, payload: await readBoundedJson(response, controller.signal) };
      })(),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        cancel();
        return undefined;
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      return undefined;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
