# ADR-15 — Model Comparison Is Observational, and Says So

**Decision:** Every trace records the model alias the caller requested. The Prompts page
compares the models that served one prompt using the same statistics as an A/B test, and
states plainly — in the panel, not only here — that nothing randomised which call went to
which model.

## Why this exists

Providers retire models and reprice them, and the question that follows is always the same:
*can we move to the cheaper one without making the product worse?* Teams answer it by
feel, switch, and find out in production.

PromptWatch was one column short of answering it. It priced every call per model and never
stored which model that was, so the tool that knew the cost of each call could not group by
the thing the cost depended on. `traces.model` closes that.

It is also the third axis the significance machinery has been pointed at without being
rewritten: variants ([ADR-6](006-a-winner-requires-significance-not-just-a-lower-average.md)),
releases ([ADR-14](014-detecting-a-bad-release-and-when-a-machine-may-undo-it.md)), and now
models. Welch's t-test on quality, latency and cost, a two-proportion z-test on error rate,
the same 30-per-side gate. `lib/modelComparison.ts` computes no statistics of its own.

## Why the requested alias, not the id the API returns

The same reason [ADR-7](007-a-guessed-cost-is-labelled-as-a-guess.md) prices against the
request: the API answers `gpt-4o-mini` with a dated snapshot id. Recording that would split
one model into a new identity every time the provider dates a release, and a migration
decision is about the alias — nobody asks whether to move to `gpt-4o-mini-2024-07-18`.

## Why null models are excluded rather than bucketed

Traces written by SDK builds from before this column exist and genuinely do not know which
model served them. Grouping them as "unknown" would be honest; folding them into a named
model would not, and a default value in the migration would have made them indistinguishable
from measured rows. They are left out of the comparison and shown as `—` in the call list.

## The limit, stated plainly

**This is not an A/B test.** An A/B test assigns each call to an arm by a rule that ignores
the call's content; this compares whatever traffic each model happened to receive. If one
model was used only for the hard requests, or only during an incident, or only by one
customer, it will look worse than it is and the p-value will not notice.

So a significant difference here is a reason to run a controlled test, not a result. That
sentence appears above the table in the dashboard, because a caveat that lives only in an
ADR is a caveat nobody reads — the same conclusion [ADR-13](013-attribution-is-not-authentication.md)
reached about unverified names.

The weaker evidence is worth having anyway: it costs nothing to collect, it uses traffic
that already happened, and "these two look identical across 4,000 calls" is a useful thing
to know before spending a week on an experiment.

## Why cost sometimes has no verdict at all

When either model's price is a guess, no cost comparison is produced — not "inconclusive",
which would say the difference was too small to call. The fallback rate is the *same
constant* for every unknown model, so testing two guesses against each other would produce a
confident finding about arithmetic rather than about cost. Quality, latency and error rate
are unaffected and still reported.

## When to revisit

The randomised version is the obvious next step and deliberately not here: the SDK already
substitutes prompt text for an A/B variant, and substituting the model on the same sticky
bucketing would make this a real experiment rather than an observation. That is a feature —
a new test type, a second thing the backend must refuse to run concurrently with a prompt
test, and a UI for starting it — and it should not be smuggled in as a column.

Until then this answers "is it worth investigating", and nothing stronger.
