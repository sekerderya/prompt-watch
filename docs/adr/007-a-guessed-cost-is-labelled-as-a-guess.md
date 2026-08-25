# ADR-7 — A Guessed Cost Is Labelled as a Guess

**Decision:** Pricing is resolved by longest-prefix match against the request's model id.
When nothing matches, the fallback rate is still applied but the trace is flagged
`pricingUnknown`, and every aggregate that includes such a trace is rendered with a `~`
prefix and an explicit "estimated" note.

**Why:** Cost was previously derived from `response.model`, which the API returns as a
dated snapshot id (`gpt-4o-mini-2024-07-18`) rather than the alias you requested. No
pricing key matched, so every call silently fell through to the default rate — roughly 16x
the true cost for `gpt-4o-mini`. The failure was invisible: the dashboard displayed a
precise-looking dollar figure that was simply wrong, and the unit tests missed it because
the mock echoed back the alias instead of a snapshot id.

Two changes follow from that. Prices are resolved from the *requested* model, matching
dated suffixes by prefix; and an unmatched model is surfaced rather than absorbed, because
a wrong number presented confidently is worse than an acknowledged estimate. Adding a
model to `packages/sdk/src/pricing.ts` removes the flag.
