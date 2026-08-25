# ADR-14 — Detecting a Bad Release, and When a Machine May Undo It

**Decision:** Every live release is continuously compared against the version it replaced,
using the same statistics the A/B page uses. Detection is always on. Reverting without a
human is **opt-in** (`PROMPTWATCH_AUTO_ROLLBACK=true`) and held to a strictly higher bar than
detection.

## Why this is required rather than nice

[ADR-11](011-the-registry-serves-prompts-the-code-still-owns-them.md) is the point where
this stopped being an observability tool. Before it, the worst outcome of a bug here was bad
data. After it, promoting a prompt changes what a production application says to its users.

A system that can change production and cannot tell when the change was bad is not finished.
Noticing is the obligation that comes with the capability, and it belongs to the tool rather
than to whoever remembers to check the dashboard on Monday.

## Why the comparison is small

The axis is the only new thing: "the window before this release versus everything after"
instead of "variant A versus variant B". Welch's t-test on quality and latency, a
two-proportion z-test on error rate, and the same 30-samples-per-side gate all carry over
unchanged from [ADR-6](006-a-winner-requires-significance-not-just-a-lower-average.md).

That is the payoff for having put the statistics behind a real interface rather than inline
in a component. `lib/regression.ts` is a few hundred lines because it computes nothing new.

**The "before" window is bounded on both sides.** It is the previous version's traffic in
the hours immediately preceding the release, not its entire history. A version that ran well
for a month and badly for the final hour before being replaced should be compared on that
final hour — otherwise every replacement of a long-lived prompt looks like a regression
against its own golden age. A test pins this: 500 excellent ancient calls do not enter the
comparison.

## Why detection and action are separate decisions

Detection asks *is this real*. Action asks *am I confident enough to change production
without asking*. Those are different questions, and collapsing them means every significant
blip reverts a deploy.

The stricter bar for acting unattended has two parts:

- **Evidence.** 100 calls per side by default, against 30 for reporting. Significance at
  n=30 is a legitimate signal to a human and a thin basis for an automated production change.
- **Metric.** Only quality and error rate. **Latency regressions are reported and never
  auto-reverted**, because a slower prompt that produces better answers is frequently the
  right trade, and a machine that silently undoes that judgement is worse than one that
  stays quiet. A test asserts this refusal specifically.

## Why opt-in

Automatic rollback is a system taking an action nobody watched it take. The failure mode is
not theoretical: a false positive reverts a good release, the next check compares the
restored version against the reverted one, and a tool that flips back and forth on noise is
worse than no tool. The evidence bar and the append-only history bound that, but the honest
default is off.

When it does act, it records what it did and why — actor `auto-rollback`, the metric, both
windows, and the p-value — as ordinary release evidence, so the decision reads the same as a
human's and reverting *it* is the same one-click operation.

## Trade-off, stated plainly

The comparison is observational, not an experiment. Traffic before and after a release
differs in more than the prompt: time of day, mix of users, upstream model changes. A/B
testing exists precisely to remove those confounds, and this cannot. It is a regression
alarm, not evidence that the new prompt caused the drop — which is why the default response
is to tell someone rather than to act.

## When to revisit

If false positives become common, the answer is not a higher p-value threshold but a
staged rollout: serve a release to a fraction of traffic and compare concurrently, which
turns this back into the A/B test it is approximating. That needs the percentage-based
targeting the registry does not have yet, and is the natural successor to this ADR.
