# ADR-8 — Outcomes Keyed on a Client-Generated Id, Not a Foreign Key

**Decision:** The SDK generates a UUID per call, hands it to the host application through
`onTrace`, and stamps it on the trace. Outcomes are stored in their own table keyed on the
same id, with **no foreign key** between them, and joined on that column when metrics are
computed.

**Why a client-generated id:** the database id is not known until the trace is written, and
the trace is written asynchronously and in batches — long after the host application has
moved on. Generating the id up front means it exists before the request even reaches
OpenAI, so it can be captured next to the call site and used for a request that ends up
failing.

**Why `onTrace` fires before the OpenAI call:** the application usually needs to stash the
id alongside its own request context, and by the time a response arrives that context is
often gone. Firing early also makes the callback synchronous — it runs before the first
`await` inside `create()` — so the id can be read immediately after the call expression and
stays correct with many calls in flight. That ordering is a contract, and a test asserts it
rather than leaving it to chance.

**Why no foreign key:** traces are buffered and batched while outcomes are sent directly, so
an outcome routinely arrives *before* the trace it belongs to. A foreign key would reject
exactly the case the design expects. Both sides carry a unique `client_trace_id`; the join
is one-to-one and therefore cannot inflate the operational aggregates, which a test checks.

**Why a single 0..1 score:** one normalised number keeps variants comparable across prompts
and keeps the significance machinery honest with a single test. Binary outcomes are 0 or 1;
a star rating is rescaled. A short `label` records what was measured and is length-capped at
the API boundary so it stays a tag rather than a channel for user content (ADR-2).

**Trade-off, stated plainly:** PromptWatch cannot verify a score. A team that reports
garbage gets a confident comparison of garbage. The alternative — inferring quality from
model output — is the thing ADR-2 exists to forbid.
