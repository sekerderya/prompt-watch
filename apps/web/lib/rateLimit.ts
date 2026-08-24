/**
 * A small fixed-window rate limiter kept in process memory.
 *
 * The auth design defends the shared secret against timing attacks but, until
 * this existed, left it open to unlimited guessing — the far cheaper attack.
 *
 * In-memory state matches the deployment model this tool targets (one
 * self-hosted instance). Behind multiple replicas each would keep its own
 * counter, which weakens but does not remove the limit; a shared store would be
 * the fix if PromptWatch ever runs replicated.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the current window resets. */
  retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Window>();

/** Keeps the map from growing without bound on a long-running process. */
function evictExpired(now: number): void {
  if (buckets.size < 1000) return;
  for (const [key, window] of buckets) {
    if (window.resetAt <= now) buckets.delete(key);
  }
}

export function rateLimit(
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number },
  now: number = Date.now()
): RateLimitResult {
  evictExpired(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  existing.count++;
  const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));

  if (existing.count > limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }
  return { allowed: true, remaining: limit - existing.count, retryAfterSeconds };
}

/** Test hook. */
export function resetRateLimits(): void {
  buckets.clear();
}

/**
 * Best-effort client identity. Behind a proxy the socket address is the proxy's,
 * so the forwarded headers are preferred when present.
 */
export function clientKey(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
