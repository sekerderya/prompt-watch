# ADR-6 — A Winner Requires Significance, Not Just a Lower Average

**Decision:** The dashboard declares a winner for a metric only when both arms have at
least 30 traces *and* the difference clears a two-sided test at α = 0.05 — Welch's t-test
for latency and cost, a two-proportion z-test for error rate. Otherwise it shows the
numbers with either "needs 30/variant — have N vs M" or "no significant difference
(p = …)".

**Why:** The earlier version picked whichever average was lower and put a "winner" badge on
it. After a demo run that meant crowning a variant on three requests per arm, which is
noise, not a result. A tool whose entire purpose is to help someone choose between two
prompts must not hand them a confident-looking answer it has no basis for. Refusing to
answer is the more useful output.

**Scope, stated plainly:** p-values use the normal approximation rather than an exact
t-distribution, which is anti-conservative for very small samples. The minimum sample gate
is what makes that acceptable; it fires before any p-value is trusted. The aggregation
query returns `STDDEV_SAMP` and per-arm counts so the decision is made from spread and
sample size, not from means alone.

**Quality is the metric that matters, and it has to come from you.** Cost, latency and
error rate are all derivable from the call itself, and they are rarely why one prompt beats
another. PromptWatch never sees model output (ADR-2), so it cannot judge an answer — the
host application reports a score and the dashboard compares variants on it, using the same
significance gate and the one direction where higher wins. See ADR-8.
