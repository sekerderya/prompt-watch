# ADR-12 — One Instrumentation, Two OpenAI APIs

**Decision:** `wrapOpenAI` instruments both `chat.completions.create` and
`responses.create`. The differences between them are confined to a small `ApiAdapter`
table; everything else — precedence, error tracing, the non-blocking guarantee, cost
accounting, stream termination, outcome correlation — is written once and shared.

## Why bother

Chat Completions is not going away, but the Responses API is where OpenAI puts new
capability, and a tool released in 2026 that only understands the older interface reads as
having been written against older documentation. More practically: an application that
adopts Responses would have silently lost all observability, with no error and no warning.

## Why an adapter rather than a second code path

This project has already been bitten by exactly that. For months the streaming path
recorded errors and the non-streaming path did not, because they were two implementations
of the same idea that drifted ([ADR-9](009-corrections.md)). Two *APIs* is a much stronger
version of the same pressure.

So the adapter interface holds only the genuine differences, and there are four:

| | Chat Completions | Responses |
| --- | --- | --- |
| System prompt | `messages[role="system"].content` | `instructions` |
| Token counts | `prompt_tokens` / `completion_tokens` | `input_tokens` / `output_tokens` |
| Stream usage | `chunk.usage`, only if requested | `event.response.usage` on `response.completed` |
| Stream preparation | inject `include_usage`, hide the extra chunk | nothing injected, nothing hidden |

Everything else routes through the same `instrument()` function. A fix to the error path is
a fix to both, by construction.

## What is verified, and what is not

The shapes above are taken from the type definitions shipped in `openai@4.104.0`
(`ResponseCreateParams.instructions`, `ResponseUsage.input_tokens/output_tokens`,
`ResponseCompletedEvent.response`), not from memory. They are checked by tests against
mocks built to match those declarations.

They are **not** verified against the live API. That distinction matters here more than
usual, because the last time this project trusted a mock over reality it shipped costs that
were wrong by a factor of sixteen — the mock echoed a model alias where the real API returns
a dated snapshot id ([ADR-7](007-a-guessed-cost-is-labelled-as-a-guess.md)).

So the implementation is built to degrade rather than break if a shape is wrong:

- **Usage parsing is tolerant.** `normalizeUsage` accepts either field pair and returns
  `undefined` for anything it does not recognise. An unrecognised shape costs the cost
  figure and the token counts; the trace, its latency and its success/failure are still
  recorded. A provider renaming a field must not delete the observation.
- **The streaming wrapper is purely observational on this API.** Nothing is injected into
  the request and no event is withheld from the caller. That is a deliberate reduction in
  capability: it means no assumption of mine about the Responses request options can
  corrupt somebody's stream. The cost is that usage depends on the terminal event carrying
  it, and if it does not, the previous bullet applies.
- **A client without `responses` is left alone.** Older `openai` releases have no such
  property, and the proxy does not invent one.

## Trade-off, stated plainly

Chat Completions streaming asks for usage and hides the resulting chunk; Responses
streaming does neither. The two are therefore not equally instrumented, and that asymmetry
is deliberate rather than an oversight: the more aggressive behaviour is only used where it
is verified against a live API.

## When to revisit

The first time anyone runs this against the real Responses API. If usage arrives as
expected, this ADR should say so and the asymmetry can be reconsidered. If it does not,
the tolerant parsing means the fix is a one-line adapter change rather than an incident.
