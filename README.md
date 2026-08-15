# PromptWatch
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-14-black.svg)](https://nextjs.org/)
[![Docker](https://img.shields.io/badge/Docker-Enabled-2496ED.svg)](https://www.docker.com/)

> Open-source, privacy-first, non-blocking LLM prompt versioning, A/B testing & telemetry observability engine.

PromptWatch is an open-source observability and prompt engineering platform designed to seamlessly wrap existing LLM clients. It provides automated prompt versioning via cryptographic SHA-256 hashing, deterministic user-level A/B testing, and real-time latency and token cost telemetry with zero blocking impact on your application's hot path.

---

## Architecture & Interception Flow

PromptWatch operates via a lightweight SDK wrapper (`@promptwatch/sdk`) sitting between your application code and the OpenAI API. Telemetry transport and active test configurations execute completely out-of-band to ensure strictly isolated execution.

```mermaid
sequenceDiagram
    autonumber
    actor User as Client App / User
    participant SDK as @promptwatch/sdk
    participant Cache as In-Memory ABCache
    participant Backend as PromptWatch API
    participant DB as PostgreSQL
    participant LLM as OpenAI Provider

    Note over SDK, Backend: Background Sync (Every N Seconds)
    loop Active Test Polling
        Cache->>Backend: GET /api/ab-tests/active
        Backend->>DB: Query Active A/B Configurations
        DB-->>Backend: Return Active Tests
        Backend-->>Cache: Sync Local Variant Map
    end

    Note over User, LLM: Request Execution Phase
    User->>SDK: wrapOpenAI().chat.completions.create(...)
    SDK->>Cache: assignVariant(promptName, distinctId)
    Cache-->>SDK: Return Variant (Prompt A or Prompt B)
    
    SDK->>Backend: POST /api/prompts/resolve (SHA-256 Hash Check)
    Backend->>DB: Upsert Prompt Version (Auto-increment vN)
    
    SDK->>LLM: Forward Intercepted Payload
    LLM-->>SDK: Return Completion Stream / Response
    SDK-->>User: Return Response to Host Application

    Note over SDK, DB: Async Non-Blocking Telemetry
    par Fire-and-Forget
        SDK--)Backend: POST /api/traces (Status, Tokens, Cost, Latency)
        Backend--)DB: Persist Telemetry Trace
    end