# ADR-3 — Non-Blocking, Fire-and-Forget Telemetry

**Decision:** Neither the prompt-resolve call nor the trace-logging call is ever awaited before the real OpenAI request is dispatched. PromptWatch's own backend health has zero effect on the latency or success of the LLM call it observes.

**Why:** An observability tool that can slow down or break the thing it observes will not survive a single production incident review. If the backend is degraded or fully down, the host application behaves exactly as if PromptWatch were never installed — the only casualty is the observability data for that window.

**How this is actually enforced:** the resolve request is dispatched in parallel with the OpenAI call and is never awaited on the path back to the caller. Because the prompt id is only known once `/resolve` answers, the trace is emitted from that promise's continuation (`resolvePromise.then(...)`) rather than from the request path. A slow backend therefore delays the *trace*, never the response the host application is waiting on. Every backend call additionally carries an `AbortSignal` timeout, so a server that accepts a connection and then hangs cannot leak a pending request.

**An earlier version of this document overstated the guarantee.** It claimed the ordering meant the await "can never add latency to the call the host application is waiting on." That was wrong: the non-streaming path did `await resolvePromise` after the OpenAI response but *before* returning, so the caller's `create()` blocked on PromptWatch's backend — and with no timeout, a hanging backend blocked it indefinitely. The streaming path was already correct. Both paths now share the same non-blocking emit, and a regression test asserts that `create()` returns in under a second while `/resolve` stalls for three.

**Backpressure:** traces are buffered in a bounded queue (default 1000) with a single request in flight at a time. Under low load a trace ships immediately; under burst load, traces that arrive during a request coalesce into the next batch, so backend round trips scale with latency rather than with call volume. Retryable failures (429, 5xx, network) are retried with backoff; a full queue drops the oldest traces and counts them, which is visible through `TelemetryClient.stats()`.

**Trade-off, stated plainly:** if the backend is down for an hour, an hour of telemetry is gone, permanently. That failure is now surfaced through an optional `onError` hook on `wrapOpenAI` instead of only reaching `console.error`.
