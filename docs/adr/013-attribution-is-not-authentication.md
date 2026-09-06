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

- anyone holding the shared key can put arbitrary text into `prompts` and have it served.
  `POST /api/prompts/resolve` accepts any name and any body, and does not check the supplied
  hash against that body; `POST /api/ab-tests` will then make two such rows the variants of
  a live test, or `POST /api/releases` will promote one outright;
- the change takes effect within one poll interval, with no deploy and no review;
- the A/B path is not opt-in. `useRegistry` gates the registry, but nothing gates variant
  assignment, so this reaches every installation rather than only the ones that asked to be
  served remote prompts;
- the record of who did it is self-declared and therefore unreliable.

One thing bounds the damage, and only partly. Releases are append-only, so a bad *release* is
visible in the history and revertible in one click. An A/B test is not a release: it never
enters that history, it carries no `actor` column at all, and it is only visible while it is
still running. The path that needs no opt-in from the application is therefore also the path
with the weakest record of having happened.

**The local prompt does not bound it, and an earlier version of this ADR wrongly said it
did.** The claim was that because the prompt in the application's own code remains the
fallback (ADR-11), the worst case is the wrong *valid* prompt rather than arbitrary injected
text. That is false. The fallback fires when the backend has nothing to say — it is a
liveness guarantee, not an integrity one — and here the backend is answering confidently
with exactly what it was told. Recorded in [ADR-9](009-corrections.md).

There is no server-side repair. With one shared secret the attacker and the application
present the same credential, so the backend cannot answer "did this text come from a real
client": a forged trace says yes just as convincingly as a real one. Any defence that
actually holds has to run where the key does not reach, which means inside the caller's own
process — see *when to revisit*.

None of this makes the shared secret adequate for a team that needs review or per-person
accountability on production changes. It is adequate for the deployment this tool targets —
one operator, one key, a trusted network — and that boundary is now stated rather than
implied.

## When to revisit

Before any of what follows: a caller-declared allowlist of prompt hashes. The application
passes the hashes it is willing to serve, the SDK checks anything the backend hands back
against that list, and falls back to the prompt in the caller's own code when it does not
match. It is the smaller of the two changes described here and it removes the worst outcome
without introducing an identity system at all, because the check runs in the caller's
process rather than behind the shared key. It is a feature, not a wording change, which is
why this ADR records the gap instead of quietly closing it.

The full answer arrives the moment more than one person can promote. At that point the honest answer is an identity
provider (OIDC), releases carrying a verified subject rather than a typed string, and
probably an approval step between "promote" and "served" — all three together, since any one
of them alone provides a sense of accountability without the substance.
