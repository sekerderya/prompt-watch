/** Anything with a `.controller` we can abort — OpenAI's `Stream` has one. */
type AbortableStream = AsyncIterable<any> & {
  controller?: { abort?: () => void };
};

export interface StreamOutcome {
  usage: any | undefined;
  firstChunkAt: number | undefined;
  /** True when the consumer stopped iterating before the stream ended. */
  aborted: boolean;
}

export interface StreamWrapOptions {
  /**
   * Pulls usage out of a chunk. The two OpenAI APIs put it in different places
   * — `chunk.usage` for Chat Completions, `event.response.usage` on the
   * Responses API's terminal event — and this is the only difference between
   * them that matters here.
   */
  readUsage?: (chunk: any) => any | undefined;
  /**
   * True when a chunk exists only to carry usage that *we* asked for, and the
   * caller never expected to see it. Omitted means nothing is ever swallowed.
   */
  isSyntheticUsageChunk?: (chunk: any) => boolean;
}

const defaultReadUsage = (chunk: any): any | undefined =>
  chunk && typeof chunk === "object" ? chunk.usage : undefined;

/**
 * Wraps a streaming response so usage can be captured without disturbing what
 * the caller sees.
 *
 * Termination is the subtle part. A stream ends one of three ways, and all
 * three must produce telemetry exactly once:
 *   1. runs to completion            -> onDone(aborted: false)
 *   2. throws                        -> onError
 *   3. consumer `break`s or `return`s -> onDone(aborted: true)
 *
 * Case 3 is why the settle logic lives in `finally`. Without it an early break
 * silently loses the trace *and* leaves the upstream HTTP connection open,
 * which is the common case whenever a user cancels a generation.
 */
export async function* wrapStream(
  originalStream: AbortableStream,
  options: StreamWrapOptions,
  onDone: (outcome: StreamOutcome) => void,
  onError: (err: unknown, firstChunkAt: number | undefined) => void
): AsyncGenerator<any, void, unknown> {
  const readUsage = options.readUsage ?? defaultReadUsage;
  const isSynthetic = options.isSyntheticUsageChunk;

  let firstChunkAt: number | undefined;
  let capturedUsage: any | undefined;
  let settled = false;
  let completed = false;

  try {
    for await (const chunk of originalStream) {
      if (firstChunkAt === undefined) {
        firstChunkAt = Date.now();
      }

      const usage = readUsage(chunk);
      if (usage) {
        capturedUsage = usage;
        // Swallow only a chunk the caller did not ask for; anything carrying
        // real content is passed through untouched even if it also has usage.
        if (isSynthetic?.(chunk)) continue;
      }

      yield chunk;
    }
    completed = true;
  } catch (err) {
    settled = true;
    onError(err, firstChunkAt);
    throw err;
  } finally {
    if (!settled) {
      settled = true;
      if (!completed) abortUpstream(originalStream);
      onDone({ usage: capturedUsage, firstChunkAt, aborted: !completed });
    }
  }
}

function abortUpstream(stream: AbortableStream): void {
  try {
    stream.controller?.abort?.();
  } catch {
    // Aborting is best-effort cleanup; never let it mask the caller's control flow.
  }
}
