# @promptwatch/sdk

Resolves prompts against a PromptWatch backend, runs A/B testing on prompts, and sends
usage telemetry for each OpenAI call made through a wrapped client.

```ts
import { wrapOpenAI } from "@promptwatch/sdk";
import OpenAI from "openai";

const client = wrapOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), {
  promptName: "support-bot",
  backendUrl: process.env.PROMPTWATCH_BACKEND_URL!,
});

const res = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello" },
  ],
});
```

## Telemetry flushing

Telemetry is sent fire-and-forget: the caller is never blocked by the trace POST. In
serverless / edge environments the process may be frozen or terminated after the response
goes out, which can silently drop pending telemetry. Before returning the response, drain
pending traces either by awaiting `flush` or by scheduling it with your platform's
`waitUntil` API (e.g. Cloudflare Workers):

```ts
import { TelemetryClient } from "@promptwatch/sdk";

const telemetry = new TelemetryClient(process.env.PROMPTWATCH_BACKEND_URL!);

wrapOpenAI(openai, {
  promptName: "support-bot",
  backendUrl: process.env.PROMPTWATCH_BACKEND_URL!,
  telemetry,
});

// in the handler, before responding:
await telemetry.flush();
```

## A/B testing & distinct ids

`wrapOpenAI` polls `/api/ab-tests/active` (via `ABCache`) and, when an active test exists
for `promptName`, substitutes the chosen variant's system prompt and records the
`abTestId`/`variant` on the trace. Variant assignment is deterministic per distinct id.

Provide `getDistinctId` as a callback so it is re-evaluated on every `create()` call:

```ts
wrapOpenAI(openai, {
  promptName: "support-bot",
  backendUrl: process.env.PROMPTWATCH_BACKEND_URL!,
  getDistinctId: () => currentUserIdFromRequestContext(),
});
```

Pass an `ABCache` instance if you need to control polling lifetime:

```ts
const cache = new ABCache();
cache.start(process.env.PROMPTWATCH_BACKEND_URL!, 30_000);
wrapOpenAI(openai, { promptName: "support-bot", backendUrl, cache });
// on shutdown: cache.stop();
```

## ADR-5: Transparent Streaming Support via Stream Wrapping

- **Decision**: Wrap the OpenAI `create()` response stream with `wrapStream` so that
  `include_usage` can be injected silently (the synthetic usage-only chunk is never
  yielded to the caller). Latency is measured as time-to-first-chunk, not total stream
  duration.
- **Why**: Transparent wrapping means existing non-streaming code paths are untouched; the
  streaming block is inserted only when `(requestBody as any).stream === true`. This keeps
  the fire-and-forget telemetry principle intact and avoids blocking the real OpenAI call.
- **Trade-off**: The `Stream` class's other methods (e.g., pipe, transform) are not replicated
  — only `for-await-of` consumption is supported. Users needing advanced stream transformations
  must handle them outside the wrapper.
- **When-to-revisit**: If future work requires full stream pipeability or Backpressure-aware
  processing, a dedicated `Stream` class with full AsyncIterable operations should be built
  separately, leaving `wrapStream` as the lightweight telemetry-only adapter.