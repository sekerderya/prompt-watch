# ADR-11 — The Registry Serves Prompts; the Code Still Owns Them

**Decision:** A prompt version can be *released*, and SDK clients started with
`useRegistry: true` send the released text instead of the text in their own source. The
prompt passed to `create()` is still required, still authoritative, and is what gets sent
whenever the registry has nothing to say — including when PromptWatch is unreachable.

Precedence, highest first:

1. an active A/B test variant,
2. the released version from the registry,
3. the prompt in the caller's code.

## Why this exists at all

Everything before this ADR made the tool able to answer a question and unable to act on it.
The dashboard would say *variant B is better, p = 0.001*, and the next step was to open an
editor, change a string, and deploy. The measurement and the change lived in different
systems, which is exactly the gap that makes teams stop running experiments.

"Promote winner" closes that loop: the decision and the rollout become one action, and the
reason is recorded next to it.

## The problem this creates, and how it is contained

Serving prompts remotely puts PromptWatch on the path of the application's behaviour. That
is a direct threat to [ADR-3](003-non-blocking-fire-and-forget-telemetry.md), whose entire
claim is that this backend can be down without the host application noticing. A naive
implementation — fetch the prompt, then call the model — would turn an observability tool
into a hard runtime dependency and a new single point of failure.

Three things keep ADR-3 intact:

- **The local prompt is never optional.** `create()` still takes the full system prompt.
  The registry overrides it; it does not supply it. There is no code path where a missing
  release leaves the application with nothing to send.
- **Reads are from cache, never from the network.** The released text comes from a polled
  in-memory map, the same mechanism and the same reasoning as
  [ADR-1](001-in-memory-abcache-over-a-centralized-redis.md). No request waits on a
  registry lookup.
- **A failed poll changes nothing.** The cache keeps its last known-good value on error and
  holds nothing at all if it has never succeeded, in which case the local prompt is used.
  A backend outage degrades the *rollout*, never the application.

The demo shows both halves of this: a client whose code still contains the losing prompt
sends the promoted one, and the same client pointed at a dead backend silently sends its
own text again.

## Why opt-in

Substituting text the caller did not write is a decision an application makes, not a side
effect of upgrading a dependency. With `useRegistry` off — the default — the SDK behaves
exactly as it did before this feature existed, and a release is inert.

The cost is a real one: someone can promote a winner in the dashboard and see nothing
happen because no client opted in. The UI says so at the point of promotion rather than
leaving it to be discovered.

## Why releases are append-only

There is no `isCurrent` column. The live release for a prompt is simply its most recent
row, computed with `DISTINCT ON`. A mutable pointer plus a history table is two things that
must agree, and the failure mode when they disagree is silent and severe: the dashboard
showing one version while the SDK serves another.

This also makes rollback an ordinary insert rather than a special operation, which is worth
a great deal at the moment someone actually needs it.

## Why the local prompt is still registered when a release overrides it

When the registry is serving v3 and a new deploy changes the code to something else, that
new text is still sent to `/resolve` in the background. Without it the registry would
freeze on whatever was released first: the newly written prompt would never appear as a
version, and so could never be promoted. It is registered, not served.

## Why promotion recomputes its own evidence

`/api/ab-tests/[id]/promote` re-runs the comparison server-side and stores the result on
the release, rather than accepting numbers from the client that already displayed them. A
release justified by figures the caller supplied is justified by nothing. The snapshot also
outlives the traces behind it, which retention will eventually delete — a release has to
keep explaining itself after its evidence has aged out.

The API deliberately does not require a version to have won anything. The A/B page only
offers the button for a significant winner, but a rollback at 3am must never be blocked by
a p-value.

## When to revisit

Two limits are known and accepted for now. Propagation is bounded by the poll interval, so
a release takes up to ~30 seconds to reach every instance; a kill-switch would need push
invalidation, the same conclusion ADR-1 reached. And releases are global — there is no
per-environment targeting, so staging and production sharing one backend would share one
release. Splitting those is the point at which this needs an environment dimension rather
than another flag.
