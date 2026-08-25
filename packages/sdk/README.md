# @promptwatch/sdk

Wraps an OpenAI client so every system prompt is versioned automatically, requests can be
routed through a live A/B test, and each call's cost, latency and outcome reach a
[PromptWatch](https://github.com/sekerderya/prompt-watch) backend — without the backend
ever sitting on the path of your model call.

```ts
import OpenAI from "openai";
import { wrapOpenAI } from "@promptwatch/sdk";

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

`wrapOpenAI` returns a **proxy**. The client you pass in is never mutated, so the same
instance can still be used unwrapped, and wrapping an already-wrapped client is a no-op
rather than a source of duplicate traces.

Both `chat.completions.create` and `responses.create` are intercepted, and instrumented
identically — the prompt lives in `messages[role:"system"]` for one and `instructions` for
the other, and everything downstream is the same code:

```ts
await client.responses.create({
  model: "gpt-4o-mini",
  instructions: "You are a helpful assistant.",
  input: "Hello",
});
```

Every other property passes straight through to the underlying client, and a client from an
`openai` release without a `responses` property is left untouched.

One asymmetry is deliberate: on Chat Completions the wrapper asks for streaming usage and
hides the extra chunk that produces, while on the Responses API it injects nothing and
withholds nothing. See ADR-12 — the more intrusive behaviour is only used where it has been
verified against a live API.

## What is sent, and what is not

| Sent to the backend | Never sent |
| --- | --- |
| The `role: "system"` prompt text and its SHA-256 | `role: "user"` content |
| Token counts, cost, latency, success/failure | The model's `role: "assistant"` output |
| A coarse error category (e.g. `RATE_LIMIT`) | Error messages, which could quote user input |

The error category is derived from the HTTP status and the error's class name only. No
message text is read, so nothing a user typed can reach telemetry through an error string.

## Runtime support

Node 18+, Deno, Bun, browsers, and edge runtimes (Vercel Edge, Cloudflare Workers). The
SDK has **no Node built-in imports**: it ships its own synchronous SHA-256 rather than
using `node:crypto`, and falls back through `crypto.randomUUID` → `getRandomValues` for
trace ids. Everything else needs only `fetch` and `AbortSignal`.

`openai` is a peer dependency; nothing else is required at runtime.

## Telemetry flushing

Traces are queued and shipped in the background — the caller is never blocked by the trace
POST. In serverless and edge environments the process may be frozen the moment the response
goes out, which silently drops whatever is still queued. Drain it before responding:

```ts
import { TelemetryClient } from "@promptwatch/sdk";

const telemetry = new TelemetryClient(process.env.PROMPTWATCH_BACKEND_URL!);

const client = wrapOpenAI(openai, {
  promptName: "support-bot",
  backendUrl: process.env.PROMPTWATCH_BACKEND_URL!,
  telemetry,
});

// in the handler, before responding — or via your platform's waitUntil():
await telemetry.flush();
```

Under load the queue batches automatically: a lone trace ships immediately, while traces
arriving during an in-flight request coalesce into the next batch. The queue is bounded
(1000 by default); once full the oldest are dropped and counted, visible through
`telemetry.stats()`.

## Several prompts in one application

`wrapOpenAI` tracks one prompt per wrapped client, which is what makes variant substitution
unambiguous. An application with a support bot, a summariser and a classifier should share
one poll loop and one telemetry queue between them rather than wiring each separately:

```ts
import { createPromptWatch } from "@promptwatch/sdk";

const pw = createPromptWatch({
  backendUrl: process.env.PROMPTWATCH_BACKEND_URL!,
  apiKey: process.env.PROMPTWATCH_API_KEY,
});

const support = pw.wrap(openai, { promptName: "support-agent" });
const summariser = pw.wrap(openai, { promptName: "summariser" });

// on shutdown
await pw.close();
```

## Reporting outcomes

Cost and latency are measured for you. Whether an answer was any *good* is something only
your application knows — so it tells PromptWatch, and the dashboard compares prompt
variants on it.

`onTrace` fires **synchronously inside `create()`**, before the request reaches OpenAI, so
the id can be captured next to the call site even with many calls in flight:

```ts
import { OutcomeClient } from "@promptwatch/sdk";

const outcomes = new OutcomeClient(backendUrl, apiKey);

let pendingTraceId: string | undefined;
const client = wrapOpenAI(openai, {
  promptName: "support-agent",
  backendUrl,
  onTrace: (handle) => { pendingTraceId = handle.traceId; },
});

const answer = await client.chat.completions.create({ model, messages });
const traceId = pendingTraceId!;   // read before the first await

// ...later, once the outcome is known:
await outcomes.record(traceId, { score: 1, label: "resolved" });
```

`score` is normalised to `0..1` so variants stay comparable: a binary outcome is `0` or
`1`, a 1-5 star rating is `(stars - 1) / 4`. Recording is idempotent per trace id, and an
outcome may safely arrive before the trace it belongs to.

## Serving released prompts

A version promoted in the dashboard can be served to running clients without a deploy.
Opt in per client:

```ts
const client = wrapOpenAI(openai, {
  promptName: "support-agent",
  backendUrl,
  useRegistry: true,
});
```

The system prompt you pass to `create()` is still required and still authoritative. The
registry *overrides* it; it never replaces it. Precedence is: active A/B variant, then the
released version, then your own text — and your own text is what gets sent whenever nothing
is released or the backend is unreachable. That fallback is what keeps this from turning
PromptWatch into a runtime dependency.

`onTrace` reports which one was used:

```ts
onTrace: (handle) => {
  handle.promptSource; // "ab-test" | "registry" | "local"
  handle.releaseId;    // set when promptSource is "registry"
};
```

Releases propagate on the next poll (~30s by default). Your local text is still registered
in the background even while a release overrides it, so a prompt edited in a new deploy
still shows up as a version you can promote.

## A/B testing & distinct ids

`wrapOpenAI` polls `/api/ab-tests/active` (via `ABCache`) and, when an active test exists
for `promptName`, substitutes the chosen variant's system prompt and records the
`abTestId`/`variant` on the trace. Assignment is `SHA-256(testId:distinctId) % 100`, so the
same user always lands in the same variant, on any machine, with no coordination.

Pass `getDistinctId` as a callback so it is re-evaluated on every call:

```ts
wrapOpenAI(openai, {
  promptName: "support-bot",
  backendUrl,
  getDistinctId: () => currentUserIdFromRequestContext(),
});
```

Without a distinct id there is nothing stable to hash, so each call gets an effectively
random bucket. That is correct for genuinely anonymous traffic, but the assignment is no
longer sticky — supply an id whenever one exists.

Pass an `ABCache` if you need to control the polling lifetime:

```ts
const cache = new ABCache();
cache.start(backendUrl, 30_000);
wrapOpenAI(openai, { promptName: "support-bot", backendUrl, cache });
// on shutdown: cache.stop();
```

Polls are jittered so replicas do not synchronise, and the timer is unref'd so a short-lived
script still exits.

## Streaming

Streaming is transparent: `stream: true` is detected, `include_usage` is injected silently
(the synthetic usage-only chunk is never yielded to you), and latency is recorded as
time-to-first-chunk. Breaking out of the loop early still records the call and aborts the
upstream connection.

The wrapper supports `for await...of` consumption. It does not reimplement the OpenAI
`Stream` class's other methods (`tee`, `toReadableStream`); it is a telemetry adapter, not a
full stream layer.

## Model pricing

Costs are priced by longest-prefix match against the model you requested, so dated snapshot
ids (`gpt-4o-mini-2024-07-18`) resolve correctly. A model the built-in table does not know
is billed at a fallback rate and the trace is flagged `pricingUnknown`, which the dashboard
surfaces as an estimate rather than a measurement.

Provider prices move faster than this package is republished, so supply your own:

```ts
wrapOpenAI(openai, {
  promptName: "support-bot",
  backendUrl,
  pricing: {
    "gpt-4o-mini": { promptPricePer1k: 0.00015, completionPricePer1k: 0.0006 },
    "your-model": { promptPricePer1k: 0.002, completionPricePer1k: 0.004 },
  },
});
```

## Failure behaviour

PromptWatch's own backend never affects the call it observes:

- The prompt-resolve request is dispatched in parallel and never awaited on the path back
  to the caller.
- Every backend request carries an `AbortSignal` timeout, so a server that accepts a
  connection and then hangs cannot hang your application.
- If the backend is down, the host application behaves exactly as if the SDK were not
  installed; the only loss is telemetry for that window.

Surface those losses instead of letting them reach `console.error`:

```ts
wrapOpenAI(openai, {
  promptName: "support-bot",
  backendUrl,
  onError: (error, { operation }) => logger.warn({ error, operation }, "promptwatch degraded"),
});
```

## API

| Export | Purpose |
| --- | --- |
| `wrapOpenAI(client, options)` | Returns a traced proxy over an OpenAI client |
| `PromptCache` | Caches released prompt versions for `useRegistry` clients |
| `createPromptWatch(options)` | Shared cache/telemetry/outcomes for several prompts |
| `OutcomeClient` | Records the quality score for a traced call |
| `TelemetryClient` | Trace queue; `flush()`, `close()`, `stats()` |
| `ABCache`, `assignVariant` | A/B test cache and deterministic bucketing |
| `resolvePricing`, `MODEL_PRICING` | Cost resolution and the built-in price table |
| `classifyError` | Maps a thrown error to a coarse category |
| `sha256`, `randomId` | The portable primitives the SDK runs on |
