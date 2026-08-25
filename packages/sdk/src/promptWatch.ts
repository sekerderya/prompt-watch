import type OpenAI from "openai";

import { ABCache } from "./abTesting";
import { PromptCache } from "./promptRegistry";
import { OutcomeClient } from "./outcomes";
import { TelemetryClient, type TelemetryOptions } from "./telemetry";
import { wrapOpenAI, type TraceHandle } from "./wrapOpenAI";
import type { ModelPricing } from "./pricing";

export interface PromptWatchOptions {
  backendUrl: string;
  apiKey?: string;
  /** Timeout for PromptWatch's own backend calls. Never applied to the model call. */
  backendTimeoutMs?: number;
  /** How often the shared A/B cache refreshes. Defaults to 30s. */
  pollIntervalMs?: number;
  telemetry?: TelemetryOptions;
  pricing?: Record<string, ModelPricing>;
  /**
   * Serve prompt versions promoted in the dashboard instead of the text in this
   * code. Off by default; see ADR-11 for why that default is deliberate.
   */
  useRegistry?: boolean;
  onError?: (
    error: unknown,
    context: { operation: "resolve" | "telemetry" | "outcome" }
  ) => void;
}

export interface WrapOptions {
  promptName: string;
  getDistinctId?: () => string | undefined;
  onTrace?: (handle: TraceHandle) => void;
}

export interface PromptWatch {
  /** Wraps a client for one prompt. Call it once per prompt you track. */
  wrap(client: OpenAI, options: WrapOptions): OpenAI;
  outcomes: OutcomeClient;
  telemetry: TelemetryClient;
  cache: ABCache;
  /** Undefined unless `useRegistry` was enabled. */
  promptCache?: PromptCache;
  /** Drains buffered telemetry. Call before a short-lived process exits. */
  flush(): Promise<void>;
  /** Flushes, then stops the A/B poll. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * One PromptWatch instance for an application that tracks several prompts.
 *
 * `wrapOpenAI` takes a single `promptName`, which is right — a wrapped client
 * substitutes one prompt's variants — but a real application has a support bot,
 * a summariser and a classifier, and wiring each one separately gives each its
 * own A/B poll and its own telemetry queue against the same backend.
 *
 * This shares the cache, the telemetry queue and the outcome client across all
 * of them, so N prompts still cost one poll loop and one batching queue, and
 * shutdown is a single call:
 *
 * ```ts
 * const pw = createPromptWatch({ backendUrl, apiKey });
 *
 * const support = pw.wrap(openai, { promptName: "support-agent" });
 * const summariser = pw.wrap(openai, { promptName: "summariser" });
 *
 * // on shutdown
 * await pw.close();
 * ```
 *
 * Note that each `wrap` call returns a distinct proxy over the same underlying
 * client; the client itself is never mutated, so this is safe.
 */
export function createPromptWatch(options: PromptWatchOptions): PromptWatch {
  const { backendUrl, apiKey, backendTimeoutMs, onError } = options;

  const cache = new ABCache();
  cache.start(backendUrl, options.pollIntervalMs ?? 30000, apiKey, {
    requestTimeoutMs: backendTimeoutMs,
    onError: onError ? (err) => onError(err, { operation: "resolve" }) : undefined,
  });

  const telemetry = new TelemetryClient(backendUrl, apiKey, {
    requestTimeoutMs: backendTimeoutMs,
    ...options.telemetry,
    onError:
      options.telemetry?.onError ??
      (onError ? (err) => onError(err, { operation: "telemetry" }) : undefined),
  });

  let promptCache: PromptCache | undefined;
  if (options.useRegistry) {
    promptCache = new PromptCache();
    promptCache.start(backendUrl, options.pollIntervalMs ?? 30000, apiKey, {
      requestTimeoutMs: backendTimeoutMs,
      onError: onError ? (err) => onError(err, { operation: "resolve" }) : undefined,
    });
  }

  const outcomes = new OutcomeClient(backendUrl, apiKey, {
    requestTimeoutMs: backendTimeoutMs,
    onError: onError ? (err) => onError(err, { operation: "outcome" }) : undefined,
  });

  return {
    wrap(client, wrapOptions) {
      return wrapOpenAI(client, {
        promptName: wrapOptions.promptName,
        getDistinctId: wrapOptions.getDistinctId,
        onTrace: wrapOptions.onTrace,
        backendUrl,
        apiKey,
        backendTimeoutMs,
        pricing: options.pricing,
        cache,
        promptCache,
        useRegistry: options.useRegistry,
        telemetry,
        onError,
      });
    },
    outcomes,
    telemetry,
    cache,
    promptCache,
    flush: () => telemetry.flush(),
    async close() {
      await telemetry.close();
      cache.stop();
      promptCache?.stop();
    },
  };
}
