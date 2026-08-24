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