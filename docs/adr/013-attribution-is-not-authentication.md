# ADR-13 — Attribution Is Not Authentication

**Decision:** A release records a self-declared `actor` — a name the dashboard asks for once
and remembers in the browser. It is stored, shown in the release history, and never
verified. The API accepts a release without one.

## Why this exists

[ADR-11](011-the-registry-serves-prompts-the-code-still-owns-them.md) changed what the
dashboard is. Before it, the dashboard read data. After it, the dashboard decides what
prompt a running production application sends. That is a different kind of object, and it
arrived without the surrounding record-keeping such an object needs.

The gap was concrete: a release stored *what* changed, *when*, and *why* — and nothing about
*who*. "Who rolled this back at 3am" is a question teams need answered far more often than
they need it proven, and it was unanswerable.

## Why the name is not verified

[ADR-4](004-opt-in-shared-secret-auth-not-multi-user-accounts.md) chose a single shared
secret over a user system, for reasons that still hold: this is a self-hosted, single-
operator tool, and passwords, sessions, resets and a user-management UI are an enormous
surface for a problem that did not need them.

The consequence is that there is genuinely no identity to read. Every request is the same
principal. Recording a name is therefore *attribution*, not *authentication*: it answers
"who says they did this" and cannot answer "who did this". Anyone with the shared key can
type any name.

That is worth having anyway, and pretending otherwise would be the worse error. A blameless
history that says "v3 → v1, rolled back, 03:12" is far less useful than one that says
"…by Derya", and the honest response to not being able to verify it is to say so — in the
UI, at the point where it is asked for, and here.

## What ADR-4's threat model no longer covers

ADR-4 stated the threat model as "protect the dashboard and API from casual access on a
shared network". That was written when the dashboard could only be *read*. It now includes:

- anyone holding the shared key can change what production prompts an application sends;
- the change takes effect within one poll interval, with no deploy and no review;
- the record of who did it is self-declared and therefore unreliable.

Two things bound the damage. The prompt in the application's own code remains the fallback
(ADR-11), so the worst case is the wrong *valid* prompt rather than no prompt or arbitrary
injected text. And releases are append-only, so a bad change is visible and reversible
rather than silent.

Neither of those makes the shared secret adequate for a team that needs review or per-person
accountability on production changes. It is adequate for the deployment this tool targets,
and that boundary is now stated rather than implied.

## When to revisit

The moment more than one person can promote. At that point the honest answer is an identity
provider (OIDC), releases carrying a verified subject rather than a typed string, and
probably an approval step between "promote" and "served" — all three together, since any one
of them alone provides a sense of accountability without the substance.
