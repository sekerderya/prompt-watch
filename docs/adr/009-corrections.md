# ADR-9 — Corrections

Each entry below is a claim this project made and did not keep. They are recorded rather
than quietly fixed, because the gap between the two is the most useful thing a reader can
know about a codebase.

| Claim | What was actually true | Now enforced by |
| --- | --- | --- |
| "Real-time error rate telemetry" | The non-streaming path had no `try/catch`, so `status: "ERROR"` could never be produced. The dashboard's error rate was structurally 0%; the seed script's fake errors were the only ones ever seen. | `wrapOpenAI` traces both outcomes; `records an ERROR trace when the OpenAI call fails` |
| "Real-time cost telemetry" | Cost was priced from `response.model`, a dated snapshot id no alias matched, so every call fell back to gpt-4o rates — ~16x too high for gpt-4o-mini. Unit tests missed it because the mock echoed the alias. | Longest-prefix resolution against the *requested* model; `prices against the requested model, not the dated snapshot echoed back` |
| ADR-3: the await "can never add latency to the call the host application is waiting on" | It could. The non-streaming path awaited `/resolve` before returning, with no timeout, so a hanging backend hung the caller indefinitely. | Emission from the promise continuation plus `AbortSignal` timeouts; `returns to the caller without waiting for a hanging backend` |
| ADR-1: polls are "jittered to avoid a synchronized thundering-herd" | `setInterval` with a fixed period. There was no jitter. | Self-rescheduling timeout with a jitter ratio |
| "Deterministic A/B testing" | Nothing could stop a test, so a second demo run left two active tests for one prompt and the SDK cache picked whichever response arrived last. | `PATCH /api/ab-tests/[id]`, a 409 on a duplicate active test, and `allows exactly one active test when creates race` |
| "The winner of each metric is highlighted automatically" | The winner was whichever average was lower, at any sample size. Three requests per arm produced a confident badge on noise. | ADR-6's significance gate; `refuses to call a winner below the minimum sample size` |
| "Set `PROMPTWATCH_API_KEY` in `.env`" for a shared deployment | Compose never forwarded the variable, so following the instruction left auth disabled while appearing to enable it. | Explicit pass-through in `docker-compose.yml`; `docker-compose.prod.yml` refuses to start without it |
| CI green | The lint step caught its own failure and echoed "Lint skipped", exiting 0. There was no linter in the repo at all. | ESLint plus a CI pipeline where every step can fail the build |
| The SDK README's edge/Cloudflare Workers guidance | The SDK imported `node:crypto` in three modules, so it could not run in any of the runtimes its own README recommended. This one was introduced *while writing the rest of this table*, which is the point: unkept claims are not a phase a project passes through. | A dependency-free SHA-256 and a `crypto.randomUUID` → `getRandomValues` chain, with `matches node:crypto across the padding boundaries` and `buckets exactly as the previous node:crypto implementation did` |
| The advisory lock protects version assignment | It did, but it also serialised *every* resolve for a prompt name — including the unchanged-prompt case that runs on every LLM call — and Prisma's 2s transaction-start default turned contention into P2028 failures. Nothing tested it, so neither was visible. | A lock-free fast path for unchanged prompts, a single-statement insert under the lock, and `assigns unique consecutive versions under concurrent writes` |

The last row is the one worth dwelling on: it was found by writing the database tests, not
by reading the code. Two of these bugs existed *because* the test suite ran without a
database and the mocks were kinder than reality.
