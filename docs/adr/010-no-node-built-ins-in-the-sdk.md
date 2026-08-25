# ADR-10 — No Node Built-Ins in the SDK

**Decision:** `@promptwatch/sdk` imports nothing from `node:*`. It ships a synchronous
SHA-256 implementation of its own and obtains trace ids through
`crypto.randomUUID` → `crypto.getRandomValues` → a documented last resort. The only
platform APIs it requires are `fetch` and `AbortSignal`.

**Why:** the SDK runs inside the host application, and LLM applications are frequently
deployed to runtimes that are not Node — Vercel Edge, Cloudflare Workers, Deno, Bun, and
increasingly the browser for prototypes. The package's own README recommended exactly those
environments while three of its modules imported `node:crypto`, which would have failed at
import time. ADR-4 had already reached this conclusion for the backend middleware and
switched it to Web Crypto; the SDK simply had not been held to the same standard.

**Why not `crypto.subtle`:** it is portable but asynchronous, and hashing sits on the
variant-assignment path. `assignVariant` is a synchronous, exported function, and making it
async to satisfy a runtime concern would push an `await` into every caller's hot path for
no benefit they can observe.

**Why reimplementing a hash is acceptable here:** it normally is not. It is acceptable in
this one case because SHA-256 is a fixed, fully specified algorithm with published test
vectors, it is being used for content addressing and bucketing rather than for security,
and — decisively — the implementation is verified against `node:crypto` directly. The tests
compare both over the padding boundaries (55, 56, 64 bytes), multi-byte UTF-8, and the
exact big-endian first word that bucketing consumes, plus 200 bucket assignments against the
previous implementation so no existing user silently moves to a different variant.

**Trade-off, stated plainly:** roughly 70 lines of cryptographic code now live in this
repository, and any bug in them is ours. The alternative was a dependency, which for a
package whose entire pitch is "wrap one function" is a cost paid by every consumer forever.

**When to revisit:** if the SDK ever needs a second hash, an HMAC, or anything genuinely
security-bearing, that is the point to take a well-reviewed dependency instead of extending
this file.
