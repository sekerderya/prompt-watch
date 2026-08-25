import { requestJson } from "./http";

export interface OutcomeInput {
  /**
   * Normalised quality signal in [0, 1], so variants of any prompt stay
   * comparable. A binary outcome ("did this resolve the ticket") is 0 or 1;
   * a 1-5 star rating is (stars - 1) / 4.
   */
  score: number;
  /** Short tag describing what was measured, e.g. "thumbs_up". Max 64 chars. */
  label?: string;
}

export interface OutcomeClientOptions {
  requestTimeoutMs?: number;
  onError?: (error: unknown) => void;
}

/** Keeps a label a tag rather than a place to smuggle user content (ADR-2). */
export const MAX_LABEL_LENGTH = 64;

export function validateOutcome(outcome: OutcomeInput): string | null {
  if (typeof outcome?.score !== "number" || !Number.isFinite(outcome.score)) {
    return "score must be a finite number";
  }
  if (outcome.score < 0 || outcome.score > 1) {
    return "score must be between 0 and 1";
  }
  if (outcome.label !== undefined) {
    if (typeof outcome.label !== "string") return "label must be a string";
    if (outcome.label.length > MAX_LABEL_LENGTH) {
      return `label must be at most ${MAX_LABEL_LENGTH} characters`;
    }
  }
  return null;
}

/**
 * Attaches an outcome to a call the SDK already traced.
 *
 * This is what makes A/B testing answer the question people actually have.
 * Cost and latency are measurable from token counts alone; whether a prompt
 * produces *better answers* is not. The host application is the only thing that
 * knows — a thumbs-up, a resolved ticket, a grader's verdict — so it reports a
 * number, and the dashboard compares variants on it.
 *
 * The trace id comes from `wrapOpenAI`'s `onTrace` callback, which fires
 * synchronously during `create()`:
 *
 * ```ts
 * let traceId: string | undefined;
 * const client = wrapOpenAI(openai, {
 *   promptName: "support-agent",
 *   backendUrl,
 *   onTrace: (handle) => { traceId = handle.traceId; },
 * });
 *
 * await client.chat.completions.create({ ... });
 * // ...after the user reacts:
 * await outcomes.record(traceId!, { score: 1, label: "thumbs_up" });
 * ```
 *
 * Recording is idempotent per trace id: sending again replaces the previous
 * value, so a user changing their rating is a normal update rather than a
 * duplicate row.
 */
export class OutcomeClient {
  constructor(
    private readonly backendUrl: string,
    private readonly apiKey?: string,
    private readonly options: OutcomeClientOptions = {}
  ) {}

  /**
   * Records one outcome. Awaitable, but never throws — a failed outcome must
   * not break the host application any more than a failed trace does.
   * Returns whether the backend accepted it.
   */
  async record(traceId: string, outcome: OutcomeInput): Promise<boolean> {
    return this.recordMany([{ traceId, ...outcome }]);
  }

  /** Records several outcomes in one request. */
  async recordMany(
    outcomes: (OutcomeInput & { traceId: string })[]
  ): Promise<boolean> {
    if (outcomes.length === 0) return true;

    for (const entry of outcomes) {
      if (typeof entry.traceId !== "string" || entry.traceId === "") {
        this.report(new Error("traceId is required"));
        return false;
      }
      const problem = validateOutcome(entry);
      if (problem) {
        this.report(new Error(`outcome for ${entry.traceId}: ${problem}`));
        return false;
      }
    }

    try {
      await requestJson(`${this.backendUrl}/api/outcomes`, {
        method: "POST",
        body: outcomes,
        apiKey: this.apiKey,
        timeoutMs: this.options.requestTimeoutMs,
      });
      return true;
    } catch (err) {
      this.report(err);
      return false;
    }
  }

  private report(error: unknown): void {
    if (this.options.onError) this.options.onError(error);
    else console.error("[promptwatch] outcome record failed:", error);
  }
}
