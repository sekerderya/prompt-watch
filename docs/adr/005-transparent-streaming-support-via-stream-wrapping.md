# ADR-5 — Transparent Streaming Support via Stream Wrapping

**Decision:** Wrap the OpenAI `create()` response stream with `wrapStream` so that
`include_usage` can be injected silently (the synthetic usage-only chunk is never
yielded to the caller). Latency is measured as time-to-first-chunk, not total stream
duration.

**Why:** Transparent wrapping means existing non-streaming code paths are untouched; the
streaming block is inserted only when `(requestBody as any).stream === true`. This keeps
the fire-and-forget telemetry principle intact and avoids blocking the real OpenAI call.

**Termination is the subtle part.** A stream ends one of three ways, and each must produce
telemetry exactly once: it runs to completion, it throws, or the consumer stops iterating
early. The third case is the common one — a user cancels a generation — and it was
originally unhandled: `break`ing out of the loop left the generator suspended at its
`yield`, so neither the success nor the error callback ever fired. The trace was lost and
the upstream HTTP connection stayed open. Settling now happens in a `finally` block, which
records the partial call and aborts the upstream stream.

**Trade-off:** The `wrapStream` adapter only supports `for-await-of` consumption — it does
not replicate the Stream class's other methods (pipe, transform, etc.). Users needing
advanced stream transformations must handle them outside the wrapper. This is explicitly
a telemetry-only adapter, not a full stream pipeability layer.

**When-to-revisit:** If future work requires full stream pipeability or Backpressure-aware
processing, a dedicated `Stream` class with full AsyncIterable operations should be built
separately, leaving `wrapStream` as the lightweight telemetry-only adapter.
