export async function* wrapStream(
  originalStream: AsyncIterable<any>,
  injectedIncludeUsage: boolean,
  onDone: (usage: any | undefined, firstChunkAt: number | undefined) => void,
  onError: (err: unknown, firstChunkAt: number | null) => void
): AsyncGenerator<any, void, unknown> {
  let firstChunkAt: number | undefined;
  let capturedUsage: any | undefined;


  try {
    for await (const chunk of originalStream) {
      if (firstChunkAt === undefined) {
        firstChunkAt = Date.now();
      }


      const hasUsage = Boolean(chunk && typeof chunk === "object" && chunk.usage);
      const hasNonEmptyChoices =
        chunk && typeof chunk === "object" && Array.isArray(chunk.choices) && chunk.choices.length > 0;


      if (hasUsage && !hasNonEmptyChoices && injectedIncludeUsage) {
        capturedUsage = chunk.usage;
        continue;
      }


      if (hasUsage) {
        capturedUsage = chunk.usage;
      }


      yield chunk;
    }
    onDone(capturedUsage, firstChunkAt);
  } catch (err) {
    onError(err, firstChunkAt ?? null);
    throw err;
  }
}