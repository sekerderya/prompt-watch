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

/**
 * Wraps a streaming completion so usage can be captured without the caller
 * seeing the synthetic usage-only chunk we asked for.
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
  injectedIncludeUsage: boolean,
  onDone: (outcome: StreamOutcome) => void,
  onError: (err: unknown, firstChunkAt: number | undefined) => void
): AsyncGenerator<any, void, unknown> {
  let firstChunkAt: number | undefined;
  let capturedUsage: any | undefined;
  let settled = false;
  let completed = false;

  try {
    for await (const chunk of originalStream) {
      if (firstChunkAt === undefined) {
        firstChunkAt = Date.now();
      }

      const hasUsage = Boolean(chunk && typeof chunk === "object" && chunk.usage);
      const hasNonEmptyChoices =
        chunk && typeof chunk === "object" && Array.isArray(chunk.choices) && chunk.choices.length > 0;

      if (hasUsage) {
        capturedUsage = chunk.usage;
        // Swallow the usage-only chunk only when we are the ones who asked for
        // it; if the caller set include_usage themselves it is theirs to see.
        if (!hasNonEmptyChoices && injectedIncludeUsage) continue;
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
