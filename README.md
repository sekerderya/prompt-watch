# PromptWatch

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15-black.svg?logo=next.js&logoColor=white)](https://nextjs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791.svg?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED.svg?logo=docker&logoColor=white)](https://www.docker.com/)

> Drop-in, privacy-first observability for LLM system prompts — automatic versioning, deterministic A/B testing, and real-time cost/latency telemetry, with a zero-latency guarantee on your model calls.

PromptWatch wraps your existing OpenAI client with a single function call. From that point on, every system prompt is automatically hashed and versioned, requests can be routed through a live A/B test with sticky per-user bucketing, and every call's cost, latency, and outcome streams to a self-hosted dashboard — without ever touching your users' data, and without ever adding a millisecond to your model call.

## Architecture

### Request Flow (Sequence Diagram)

```mermaid
sequenceDiagram
    autonumber
    participant App as Host Application
    participant SDK as PromptWatch SDK
    participant Cache as ABCache (in-memory)
    participant API as Backend API (Next.js)
    participant DB as PostgreSQL
    participant OpenAI as OpenAI API

    rect rgb(240, 240, 250)
    Note over Cache,API: Background sync — independent of any single request
    loop Every ~30s (jittered)
        Cache->>API: GET /api/ab-tests/active
        API->>DB: SELECT * FROM ab_tests WHERE status = 'ACTIVE'
        DB-->>API: active tests + variant prompt text
        API-->>Cache: [{id, promptName, variantA, variantB, splitPercent}]
    end
    end

    App->>SDK: chat.completions.create({ messages })
    activate SDK
    SDK->>SDK: locate the role === "system" message
    SDK->>Cache: get(promptName)

    alt Active A/B test found
        SDK->>SDK: assignVariant() — SHA-256(testId:distinctId) % 100
        SDK->>SDK: replace system prompt with the assigned variant
    else No active test
        SDK->>SDK: sha256(systemPrompt)
        SDK--)API: POST /api/prompts/resolve (fire-and-forget, never awaited here)
        API->>DB: advisory lock + upsert(name, hash) → version
        DB-->>API: {id, version}
        API--)SDK: promptId (does not block the request)
    end

    SDK->>OpenAI: chat.completions.create (the real call)
    OpenAI-->>SDK: response + token usage
    deactivate SDK
    SDK-->>App: response, returned unmodified

    SDK--)API: POST /api/traces (fire-and-forget)
    Note right of SDK: role === "user" content is never transmitted
    API->>DB: INSERT trace(promptId, abTestId?, latencyMs, costUsd, status)
```

### System Components

```mermaid
flowchart TB
    subgraph Consumer["Your Application"]
        App[Application Code]
        SDK["@promptwatch/sdk<br/>wrapOpenAI()"]
        Cache[("ABCache<br/>in-memory")]
        App -->|"chat.completions.create()"| SDK
        SDK -.->|"poll every ~30s"| Cache
    end

    subgraph Docker["docker-compose"]
        subgraph Web["apps/web (Next.js)"]
            API[API Routes]
            Dash[Dashboard UI]
        end
        PG[("PostgreSQL")]
        API <--> PG
        Dash -->|"aggregate queries"| PG
    end

    OpenAI["OpenAI API"]
    Browser["Your Browser"]

    SDK ==>|"real LLM call — synchronous"| OpenAI
    SDK -.->|"POST /api/prompts/resolve — fire-and-forget"| API
    SDK -.->|"POST /api/traces — fire-and-forget"| API
    Cache -.->|"GET /api/ab-tests/active"| API
    Browser -->|"localhost:3000"| Dash

    style OpenAI fill:#10a37f,color:#fff
    style PG fill:#336791,color:#fff
```

## Architectural Decision Records

### ADR-1 — In-Memory `ABCache` over a Centralized Redis

**Decision:** Each SDK instance holds its own in-memory `Map` of active A/B tests, refreshed on a periodic poll (default: every 30 seconds, jittered to avoid a synchronized thundering-herd across replicas).

**Why:** The variant-assignment decision sits directly on the hot path of every single LLM call. A `Map.get()` costs nothing; a network round trip to Redis would add real, avoidable latency to every request, for a decision that tolerates eventual consistency far better than it tolerates added latency. Requiring Redis as a hard dependency also raises the adoption bar for what is meant to be an `npm install`-and-go SDK.

**Trade-off, stated plainly:** instances can disagree for up to one polling interval. If a test is created or ended, already-running instances keep serving the previous state until their next poll. For A/B testing, where a few seconds of staleness costs nothing, this is a deliberate trade-off, not an oversight.

**When to revisit:** if PromptWatch ever expands from A/B testing into safety-critical feature-flagging (instant kill-switch semantics), in-memory polling stops being sufficient and a push-based invalidation layer (Redis pub/sub or a webhook) becomes necessary. That is explicitly out of scope today.

### ADR-2 — Privacy-First Data Dropping

**Decision:** The SDK inspects the outgoing message array for exactly one thing: the `role: "system"` entry. Everything else — `role: "user"` content and the model's own `role: "assistant"` output — is read only to compute token counts and is never transmitted to the backend or persisted, under any configuration.

**Why:** A system prompt is developer-authored configuration; versioning it is no different, privacy-wise, from versioning a feature flag. A user's message is exactly the class of data that KVKK (Türkiye) and GDPR (EU) exist to protect. By architecturally never transmitting it, PromptWatch removes an entire category of data-protection obligation from its own operation — there is no personal data flowing through the pipeline to be breached or governed by a DPA. This is data minimization (GDPR Art. 5(1)(c); KVKK md. 4) enforced at the architecture layer, not left as an opt-in setting that can be misconfigured.

**Trade-off, stated plainly:** this makes PromptWatch a metrics tool, not a conversation-replay tool. "Why did the model answer this specific user this way" is a question it is deliberately unable to answer. Teams that need content-level debugging need a separate, consent-aware logging layer.

### ADR-3 — Non-Blocking, Fire-and-Forget Telemetry

**Decision:** Neither the prompt-resolve call nor the trace-logging call is ever awaited before the real OpenAI request is dispatched. PromptWatch's own backend health has zero effect on the latency or success of the LLM call it observes.

**Why:** An observability tool that can slow down or break the thing it observes will not survive a single production incident review. If the backend is degraded or fully down, the host application behaves exactly as if PromptWatch were never installed — the only casualty is the observability data for that window.

**How this is actually enforced:** the resolve request is dispatched in parallel with the OpenAI call, but its promise is only ever awaited after the OpenAI response has already been returned — immediately before the trace payload is built, solely to guarantee `promptId` is populated correctly. This ordering guarantees the await can never add latency to the call the host application is waiting on.

**Trade-off, stated plainly:** if the backend is down for an hour, an hour of telemetry is gone, permanently. Surfacing that failure to the host application (an `onError` hook, rather than a silent `console.error`) is a tracked follow-up, not yet implemented.

## Quickstart

```bash
git clone https://github.com/sekerderya/prompt-watch.git
cd prompt-watch
npm install
npm run build --workspace=packages/sdk
docker compose up -d
npm run demo
```

Then open **http://localhost:3000** — the dashboard updates in real time as the demo runs.

By default the demo runs against a deterministic mock client, so no API key is required. To see it run against real OpenAI calls, add `OPENAI_API_KEY` to a `.env` file at the repo root (copy `.env.example` as a starting point) before running `npm run demo`.