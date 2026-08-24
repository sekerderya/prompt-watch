import OpenAI from "openai";

import { sha256 } from "./hash";
import { resolvePricing } from "./pricing";
import { ABCache, assignVariant, type ABTestConfig } from "./abTesting";
import { TelemetryClient } from "./telemetry";
import { wrapStream, type StreamOutcome } from "./streamWrapper";
import { requestJson } from "./http";

export interface WrapOpenAIOptions {
  promptName: string;
  backendUrl: string;
  getDistinctId?: () => string | undefined;
  cache?: ABCache;
  telemetry?: TelemetryClient;
  apiKey?: string;
  /** Timeout for PromptWatch's own backend calls. Never applied to the OpenAI call. */
  backendTimeoutMs?: number;
  /**
   * Called when PromptWatch itself fails (backend unreachable, telemetry
   * dropped). The host application's call is unaffected either way; this exists
   * so failures are observable instead of only reaching console.error.
   */
  onError?: (error: unknown, context: { operation: "resolve" | "telemetry" }) => void;
}

interface ResolveResponse {
  id: number;
  name: string;
  version: number;
}

type CreateFn = OpenAI.Chat.Completions["create"];

/** Marks an already-wrapped client so double wrapping cannot double-count traces. */
const WRAPPED = Symbol.for("promptwatch.wrapped");

const defaultCaches = new Map<string, ABCache>();

function getOrCreateCache(backendUrl: string, apiKey?: string): ABCache {
  const cacheKey = apiKey ? `${backendUrl}:${apiKey}` : backendUrl;
  const existing = defaultCaches.get(cacheKey);
  if (existing) return existing;
  const cache = new ABCache();
  cache.start(backendUrl, 30000, apiKey);
  defaultCaches.set(cacheKey, cache);
  return cache;
}

interface TraceMeta {
  promptId: number;
  abTestId: number;
  variant: string;
}

interface TraceMetrics {
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  pricingUnknown: boolean;
  status: "SUCCESS" | "ERROR";
}

function usageCost(
  model: string | undefined,
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined
): { costUsd: number; pricingUnknown: boolean } {
  if (!usage) return { costUsd: 0, pricingUnknown: false };
  const { pricing, unknown } = resolvePricing(model);
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  return {
    costUsd:
      pricing.promptPricePer1k * (promptTokens / 1000) +
      pricing.completionPricePer1k * (completionTokens / 1000),
    pricingUnknown: unknown,
  };
}

/**
 * Builds a Proxy over the client rather than reassigning
 * `client.chat.completions.create`.
 *
 * Patching in place mutates an object the caller may also be using unwrapped,
 * and wrapping the same client twice chains the wrappers so every call emits
 * two traces. A proxy leaves the original untouched and makes wrapping
 * idempotent.
 */
function proxyClient(client: OpenAI, wrappedCreate: CreateFn): OpenAI {
  const passthrough = (target: object, prop: PropertyKey): unknown => {
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  };

  const completionsProxy = new Proxy(client.chat.completions, {
    get: (target, prop) => (prop === "create" ? wrappedCreate : passthrough(target, prop)),
  });

  const chatProxy = new Proxy(client.chat, {
    get: (target, prop) => (prop === "completions" ? completionsProxy : passthrough(target, prop)),
  });

  return new Proxy(client, {
    get: (target, prop) => {
      if (prop === WRAPPED) return true;
      if (prop === "chat") return chatProxy;
      return passthrough(target, prop);
    },
  });
}

export function wrapOpenAI(client: OpenAI, options: WrapOpenAIOptions): OpenAI {
  if ((client as unknown as Record<PropertyKey, unknown>)[WRAPPED]) {
    console.warn(
      "[promptwatch] this client is already wrapped; returning it unchanged " +
        "(wrapping twice would emit duplicate traces)."
    );
    return client;
  }

  const { promptName, backendUrl, getDistinctId, apiKey, backendTimeoutMs, onError } = options;
  const cache = options.cache ?? getOrCreateCache(backendUrl, apiKey);
  const telemetry =
    options.telemetry ??
    new TelemetryClient(backendUrl, apiKey, {
      requestTimeoutMs: backendTimeoutMs,
      onError: onError ? (err) => onError(err, { operation: "telemetry" }) : undefined,
    });
  const originalCreate = client.chat.completions.create.bind(client.chat.completions);

  const resolvePrompt = (promptText: string): Promise<ResolveResponse | null> =>
    requestJson<ResolveResponse>(`${backendUrl}/api/prompts/resolve`, {
      method: "POST",
      body: { name: promptName, promptText, hash: sha256(promptText) },
      apiKey,
      timeoutMs: backendTimeoutMs,
    }).catch((err) => {
      if (onError) onError(err, { operation: "resolve" });
      else console.error("[promptwatch] prompt resolve failed:", err);
      return null;
    });

  const wrappedCreate = (async (
    body: { messages?: { role?: string; content?: unknown }[]; model?: string },
    requestOptions?: unknown
  ) => {
    const messages = body.messages ?? [];
    const systemIndex = messages.findIndex((m) => m.role === "system");
    const systemMessage = systemIndex >= 0 ? messages[systemIndex] : undefined;
    const systemText =
      systemMessage && typeof systemMessage.content === "string" ? systemMessage.content : null;

    const activeTest: ABTestConfig | undefined =
      systemText !== null ? cache.get(promptName) : undefined;

    let resolvePromise: Promise<ResolveResponse | null> | null = null;
    let requestBody = body;
    let traceMeta: TraceMeta | null = null;

    if (activeTest) {
      const assignment = assignVariant(activeTest, getDistinctId?.());
      traceMeta = {
        promptId: assignment.promptId,
        abTestId: activeTest.id,
        variant: assignment.variant,
      };
      requestBody = {
        ...body,
        messages: messages.map((m, i) =>
          i === systemIndex ? { ...m, content: assignment.promptText } : m
        ),
      };
    } else if (systemText !== null) {
      resolvePromise = resolvePrompt(systemText);
    }

    /**
     * Hands a finished measurement to the telemetry client.
     *
     * Nothing here is ever awaited by the caller. When the prompt id is only
     * known once /resolve answers, the trace is emitted from that promise's
     * continuation - so a slow or hanging backend delays the trace, never the
     * response the host application is waiting on.
     */
    const emitTrace = (metrics: TraceMetrics): void => {
      if (traceMeta) {
        telemetry.send({
          promptId: traceMeta.promptId,
          abTestId: traceMeta.abTestId,
          variant: traceMeta.variant,
          ...metrics,
        });
        return;
      }
      if (resolvePromise) {
        void resolvePromise.then((resolved) => {
          if (resolved) telemetry.send({ promptId: resolved.id, ...metrics });
        });
      }
    };

    // The model we asked for, not the one echoed back: the API returns a dated
    // snapshot id ("gpt-4o-mini-2024-07-18") that no pricing alias matches.
    const requestedModel = requestBody.model;

    if ((requestBody as { stream?: boolean }).stream === true) {
      const streamBody = requestBody as Record<string, any>;
      const originalStreamOptions = streamBody.stream_options;
      const injectedIncludeUsage = !originalStreamOptions?.include_usage;
      const finalBody = injectedIncludeUsage
        ? { ...streamBody, stream_options: { ...originalStreamOptions, include_usage: true } }
        : streamBody;

      const streamStartedAt = Date.now();

      let rawStream: any;
      try {
        rawStream = await originalCreate(finalBody as never, requestOptions as never);
      } catch (err) {
        emitTrace({
          latencyMs: Date.now() - streamStartedAt,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: 0,
          pricingUnknown: false,
          status: "ERROR",
        });
        throw err;
      }

      const finish = (
        status: "SUCCESS" | "ERROR",
        usage: any,
        firstChunkAt: number | undefined
      ): void => {
        // Latency is time-to-first-chunk, which is what a streaming UI feels.
        const latencyMs = (firstChunkAt ?? Date.now()) - streamStartedAt;
        const { costUsd, pricingUnknown } = usageCost(requestedModel, usage);
        emitTrace({
          latencyMs,
          promptTokens: usage?.prompt_tokens ?? 0,
          completionTokens: usage?.completion_tokens ?? 0,
          costUsd,
          pricingUnknown,
          status,
        });
      };

      return wrapStream(
        rawStream,
        injectedIncludeUsage,
        (outcome: StreamOutcome) => finish("SUCCESS", outcome.usage, outcome.firstChunkAt),
        (_err, firstChunkAt) => finish("ERROR", undefined, firstChunkAt)
      ) as any;
    }

    const startedAt = Date.now();

    let response: any;
    try {
      response = await originalCreate(requestBody as never, requestOptions as never);
    } catch (err) {
      // Without this the ERROR status could never be produced on the
      // non-streaming path, and the dashboard error rate was structurally zero.
      emitTrace({
        latencyMs: Date.now() - startedAt,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        pricingUnknown: false,
        status: "ERROR",
      });
      throw err;
    }

    const latencyMs = Date.now() - startedAt;
    const usage = response?.usage;
    const { costUsd, pricingUnknown } = usageCost(requestedModel ?? response?.model, usage);

    // Emitted even when usage is absent: latency and success/failure are still
    // real data, and a missing usage block should not erase the whole call.
    emitTrace({
      latencyMs,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      costUsd,
      pricingUnknown,
      status: "SUCCESS",
    });

    return response;
  }) as unknown as CreateFn;

  return proxyClient(client, wrappedCreate);
}
