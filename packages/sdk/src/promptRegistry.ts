import { PollingCache, type PollingOptions } from "./polling";

export interface PublishedPrompt {
  promptName: string;
  promptId: number;
  version: number;
  promptText: string;
  releaseId: number;
}

export type PromptCacheOptions = PollingOptions;

/**
 * Caches the prompt version each name is currently released on.
 *
 * This is what lets a winning variant actually ship: promote it in the
 * dashboard and running instances pick it up on their next poll, with no
 * deploy. It is opt-in per client (`useRegistry`), because serving text other
 * than the text in your source is a decision an application makes, not a
 * side effect of upgrading the SDK.
 *
 * The cache holds only what the backend last confirmed. When the backend is
 * unreachable it keeps serving the last known release, and when it has never
 * been reachable it holds nothing at all — in which case `wrapOpenAI` falls
 * back to the prompt in the caller's code. That fallback is what keeps ADR-3
 * intact: PromptWatch being down degrades the rollout, never the application.
 */
export class PromptCache extends PollingCache<PublishedPrompt[]> {
  protected readonly path = "/api/prompts/published";
  protected readonly label = "prompt-registry";

  private published = new Map<string, PublishedPrompt>();

  protected apply(payload: PublishedPrompt[]): void {
    if (!Array.isArray(payload)) return;
    const next = new Map<string, PublishedPrompt>();
    for (const entry of payload) {
      if (entry && typeof entry.promptName === "string" && typeof entry.promptText === "string") {
        next.set(entry.promptName, entry);
      }
    }
    this.published = next;
  }

  get(promptName: string): PublishedPrompt | undefined {
    return this.published.get(promptName);
  }

  /** Number of prompts with a released version. Exposed for diagnostics. */
  size(): number {
    return this.published.size;
  }

  /** Test hook: seed the cache without waiting for a poll. */
  seed(entries: PublishedPrompt[]): void {
    this.apply(entries);
  }
}

export type { PollingOptions };
