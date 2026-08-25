/**
 * Coarse failure classification recorded alongside an ERROR trace.
 *
 * "Error rate: 5%" is close to useless on its own — a rate-limit problem, an
 * expired key and an upstream outage all need different responses, and the
 * dashboard could not tell them apart. These categories are deliberately
 * coarse and derived only from the HTTP status and the error's own class name:
 * no message text is read, so nothing a user typed can leak into telemetry
 * through an error string (ADR-2).
 */
export type TraceErrorType =
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "AUTH"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "CONTENT_FILTER"
  | "SERVER"
  | "NETWORK"
  | "CANCELLED"
  | "UNKNOWN";

interface ErrorShape {
  status?: unknown;
  name?: unknown;
  code?: unknown;
  type?: unknown;
}

function statusOf(error: ErrorShape): number | undefined {
  return typeof error.status === "number" ? error.status : undefined;
}

export function classifyError(error: unknown): TraceErrorType {
  if (!error || typeof error !== "object") return "UNKNOWN";
  const shape = error as ErrorShape;

  const status = statusOf(shape);
  if (status !== undefined) {
    if (status === 429) return "RATE_LIMIT";
    if (status === 401 || status === 403) return "AUTH";
    if (status === 404) return "NOT_FOUND";
    if (status === 408) return "TIMEOUT";
    if (status === 400 || status === 422) return "INVALID_REQUEST";
    if (status >= 500) return "SERVER";
    if (status >= 400) return "INVALID_REQUEST";
  }

  const name = typeof shape.name === "string" ? shape.name : "";
  const code = typeof shape.code === "string" ? shape.code : "";
  const type = typeof shape.type === "string" ? shape.type : "";

  if (name === "AbortError" || code === "ABORT_ERR") return "CANCELLED";
  if (name.includes("Timeout") || code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    return "TIMEOUT";
  }
  if (type === "content_filter" || name === "ContentFilterError") return "CONTENT_FILTER";
  if (
    name === "APIConnectionError" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN"
  ) {
    return "NETWORK";
  }

  return "UNKNOWN";
}
