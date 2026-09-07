# ADR-2 — Privacy-First Data Dropping

**Decision:** The SDK inspects the outgoing message array for exactly one thing: the `role: "system"` entry. Everything else — `role: "user"` content and the model's own `role: "assistant"` output — is never transmitted to the backend or persisted, under any configuration.

The implementation is in fact stronger than that sentence needs to be: it does not read the other roles *at all*. `readPrompt` finds the system entry and stops, and token counts are taken from the provider's own `usage` object rather than computed from content. An earlier version of this decision said the rest was "read only to compute token counts", describing work the SDK never does — the safe direction to be wrong in, and still worth correcting, because a privacy claim is only useful if it describes the code.

**Why:** A system prompt is developer-authored configuration; versioning it is no different, privacy-wise, from versioning a feature flag. A user's message is exactly the class of data that KVKK (Türkiye) and GDPR (EU) exist to protect. By architecturally never transmitting it, PromptWatch removes an entire category of data-protection obligation from its own operation — there is no personal data flowing through the pipeline to be breached or governed by a DPA. This is data minimization (GDPR Art. 5(1)(c); KVKK md. 4) enforced at the architecture layer, not left as an opt-in setting that can be misconfigured.

**Trade-off, stated plainly:** this makes PromptWatch a metrics tool, not a conversation-replay tool. "Why did the model answer this specific user this way" is a question it is deliberately unable to answer. Teams that need content-level debugging need a separate, consent-aware logging layer.
