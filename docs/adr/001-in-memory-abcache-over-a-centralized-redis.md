# ADR-1 — In-Memory `ABCache` over a Centralized Redis

**Decision:** Each SDK instance holds its own in-memory `Map` of active A/B tests, refreshed on a periodic poll (default: every 30 seconds, jittered to avoid a synchronized thundering-herd across replicas).

**Why:** The variant-assignment decision sits directly on the hot path of every single LLM call. A `Map.get()` costs nothing; a network round trip to Redis would add real, avoidable latency to every request, for a decision that tolerates eventual consistency far better than it tolerates added latency. Requiring Redis as a hard dependency also raises the adoption bar for what is meant to be an `npm install`-and-go SDK.

**Trade-off, stated plainly:** instances can disagree for up to one polling interval. If a test is created or ended, already-running instances keep serving the previous state until their next poll. For A/B testing, where a few seconds of staleness costs nothing, this is a deliberate trade-off, not an oversight.

**One active test per prompt:** the cache is keyed by prompt name, so two active tests for the same prompt would make the served variant depend on response ordering. The backend rejects a second active test for a prompt (409) under the same advisory lock the resolve path uses, and the cache resolves any leftover duplicate deterministically (newest wins) while logging a warning.

**When to revisit:** if PromptWatch ever expands from A/B testing into safety-critical feature-flagging (instant kill-switch semantics), in-memory polling stops being sufficient and a push-based invalidation layer (Redis pub/sub or a webhook) becomes necessary. That is explicitly out of scope today.
