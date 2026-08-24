/**
 * Shared HTTP helpers for every backend call the SDK makes.
 *
 * Two rules hold everywhere:
 *   1. Every request carries a timeout. A backend that accepts a connection and
 *      then hangs must never be able to hang the host application.
 *   2. Auth headers are built in exactly one place.
 */

export const DEFAULT_TIMEOUT_MS = 5000;

export function authHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

/**
 * `AbortSignal.timeout` exists on Node 18+ and modern browsers. Fall back to a
 * manual controller so the SDK still enforces timeouts on older runtimes.
 */
function timeoutSignal(timeoutMs: number): {
  signal: AbortSignal;
  cancel: () => void;
} {
  const AnyAbortSignal = AbortSignal as unknown as {
    timeout?: (ms: number) => AbortSignal;
  };
  if (typeof AnyAbortSignal.timeout === "function") {
    return { signal: AnyAbortSignal.timeout(timeoutMs), cancel: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
  }

  /** 5xx and 429 are worth retrying; 4xx means the payload itself is wrong. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export async function requestJson<T>(
  url: string,
  init: { method?: string; body?: unknown; apiKey?: string; timeoutMs?: number }
): Promise<T> {
  const { signal, cancel } = timeoutSignal(init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await (globalThis.fetch as typeof fetch)(url, {
      method: init.method ?? "GET",
      headers: authHeaders(init.apiKey),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal,
    });
    if (!res.ok) throw new HttpError(res.status);
    // 204 and empty bodies are valid responses for fire-and-forget endpoints.
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  } finally {
    cancel();
  }
}
