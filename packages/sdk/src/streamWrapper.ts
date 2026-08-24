/**
 * Wraps an AsyncIterable stream to capture usage metadata and inject
 * synthetic chunks when include_usage is enabled.
 *
 * @param originalStream - The original async iterable stream (e.g. OpenAI response stream)
 * @param injectedIncludeUsage - If true, synthetic chunks with usage-only data
 *   will be injected and skipped (not yielded to the caller). This is used when
 *   the caller wants usage data but not the actual content chunks.
 * @param onDone - Called when the stream completes successfully.
 *   Receives (capturedUsage: any | undefined, firstChunkAt: number | undefined).
 *   firstChunkAt is the time (ms since epoch) when the first chunk was received.
 * @param onError - Called when the stream iteration throws.
 *   Receives (err: unknown, firstChunkAt: number | null).
 *   If firstChunkAt is null, no chunk was received before the error.
 * @returns An AsyncIterable that yields the same chunks as the original,
 *   skipping synthetic usage-only chunks when injectedIncludeUsage is true.
 */
export async function* wrapStream(
  originalStream: AsyncIterable<any>,
  injectedIncludeUsage: boolean,
  onDone: (usage: any | undefined, firstChunkAt: number | undefined) => void,
  onError: (err: unknown, firstChunkAt: number | null) => void
): AsyncIterable<any> {
  let firstChunkAt: number | undefined;
  let capturedUsage: any | undefined;

  const asyncIter = originalStream[Symbol.asyncIterator]();

  try {
    let iterationResult = await asyncIter.next();

    while (!iterationResult.done) {
      const chunk = iterationResult.value;

      // First chunk received - record the timestamp
      if (firstChunkAt === undefined) {
        firstChunkAt = Date.now();
      }

      // Check if this chunk has usage data
      const hasUsage = chunk && typeof chunk === "object" && "usage" in chunk;
      const hasChoices = chunk && typeof chunk === "object" && "choices" in chunk;
      const choicesExistAndNotEmpty = hasChoices && chunk.choices && chunk.choices.length > 0;

      // Rule: chunk has usage AND (no choices OR choices are empty)
      // AND injectedIncludeUsage is true → this is a synthetic usage chunk, skip it
      if (hasUsage && !hasChoices && injectedIncludeUsage) {
        // Update captured usage but don't yield
        capturedUsage = chunk.usage;
        iterationResult = await asyncIter.next();
        continue;
      }

      // Yield the chunk as-is
      iterationResult = await asyncIter.next();
    }

    // Stream completed normally
    onDone(capturedUsage, firstChunkAt);
  } catch (err) {
    // Stream iteration threw an error
    onError(err, firstChunkAt);
    // Re-throw so the caller can also handle the error
    throw err;
  }
}