import OpenAI from "openai";

import { sha256 } from "./hash";
import { resolvePricing, type ModelPricing } from "./pricing";
import { ABCache, assignVariant, type ABTestConfig } from "./abTesting";
import { TelemetryClient } from "./telemetry";
import { wrapStream, type StreamOutcome } from "./streamWrapper";
import { requestJson } from "./http";
import { randomId } from "./random";
import { PromptCache, type PublishedPrompt } from "./promptRegistry";
import { classifyError, type TraceErrorType } from "./errorType";

/**
 * Identifies one traced call, handed to the host application while the call is
 * still in flight so it can correlate its own outcome with this trace.
 */
export interface TraceHandle {
  /** Pass to `OutcomeClient.record()` to attach a quality signal to this call. */
  traceId: string;
  promptName: string;
  abTestId?: number;
  variant?: "A" | "B";
  /**
   * Where the prompt actually sent to the model came from. "local" means the
   * text the caller passed in - which is also what a backend outage falls back
   * to, so this is the field to assert on when testing that behaviour.
   */
  promptSource: "local" | "registry" | "ab-test";
  /** Released version served, when promptSource is "registry". */
  releaseId?: number;
}

export interface WrapOpenAIOptions {
  promptName: string;
  backendUrl: string;
  getDistinctId?: () => string | undefined;
  cache?: ABCache;
  /**
   * Serve the version promoted in the dashboard instead of the prompt in this
   * code, when one exists.
   *
   * Off by default, and deliberately so: substituting text the caller did not
   * write is a decision an application makes, never a side effect of upgrading
   * the SDK. With it on, the prompt passed to `create()` still acts as the
   * contract and the fallback - if the backend is unreachable, or nothing has
   * been promoted, that text is what gets sent (ADR-11).
   */
  useRegistry?: boolean;
  /** Share one registry cache across several wrapped clients. */
  promptCache?: PromptCache;
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
  /**
   * Fires once per call, synchronously, before the request reaches OpenAI.
   *
   * It runs early on purpose: the host application usually needs to stash the
   * trace id alongside its own request context, and by the time the response
   * arrives that context may be gone. Firing before the call also means an
   * outcome can be recorded for a request that ends up failing.
   */
  onTrace?: (handle: TraceHandle) => void;
  /**
   * Extra or corrected model prices, merged over the built-in table.
   *
   * Provider prices change faster than this package is republished, and a model
   * the table does not know is otherwise billed at the fallback rate and flagged
   * as an estimate. This is the escape hatch that does not require a fork.
   */
  pricing?: Record<string, ModelPricing>;
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
const defaultPromptCaches = new Map<string, PromptCache>();

function getOrCreateCache(backendUrl: string, apiKey?: string): ABCache {
  const cacheKey = apiKey ? `${backendUrl}:${apiKey}` : backendUrl;
  const existing = defaultCaches.get(cacheKey);
  if (existing) return existing;
  const cache = new ABCache();
  cache.start(backendUrl, 30000, apiKey);
  defaultCaches.set(cacheKey, cache);
  return cache;
}

function getOrCreatePromptCache(backendUrl: string, apiKey?: string): PromptCache {
  const cacheKey = apiKey ? `${backendUrl}:${apiKey}` : backendUrl;
  const existing = defaultPromptCaches.get(cacheKey);
  if (existing) return existing;
  const cache = new PromptCache();
  cache.start(backendUrl, 30000, apiKey);
  defaultPromptCaches.set(cacheKey, cache);
  return cache;
}

interface TraceMeta {
  promptId: number;
  abTestId: number | null;
  variant: string | null;
}

interface TraceMetrics {
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  pricingUnknown: boolean;
  status: "SUCCESS" | "ERROR";
  errorType?: TraceErrorType;
}

function usageCost(
  model: string | undefined,
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  overrides?: Record<string, ModelPricing>
): { costUsd: number; pricingUnknown: boolean } {
  if (!usage) return { costUsd: 0, pricingUnknown: false };
  const { pricing, unknown } = resolvePricing(model, overrides);
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

  const { promptName, backendUrl, getDistinctId, apiKey, backendTimeoutMs, onError, onTrace } =
    options;
  const pricingOverrides = options.pricing;
  const cache = options.cache ?? getOrCreateCache(backendUrl, apiKey);
  const promptCache = options.useRegistry
    ? options.promptCache ?? getOrCreatePromptCache(backendUrl, apiKey)
    : options.promptCache;
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
    const published: PublishedPrompt | undefined =
      !activeTest && systemText !== null ? promptCache?.get(promptName) : undefined;

    let resolvePromise: Promise<ResolveResponse | null> | null = null;
    let requestBody = body;
    let traceMeta: TraceMeta | null = null;
    let promptSource: "local" | "registry" | "ab-test" = "local";

    const substitute = (text: string) => ({
      ...body,
      messages: messages.map((m, i) => (i === systemIndex ? { ...m, content: text } : m)),
    });

    // Precedence: a running experiment outranks a release, and a release
    // outranks the caller's own text. An A/B test is a deliberate, temporary
    // override; letting a release win over one would make the test measure
    // something other than what it was set up to measure.
    if (activeTest) {
      const assignment = assignVariant(activeTest, getDistinctId?.());
      traceMeta = {
        promptId: assignment.promptId,
        abTestId: activeTest.id,
        variant: assignment.variant,
      };
      requestBody = substitute(assignment.promptText);
      promptSource = "ab-test";
    } else if (published) {
      // A released version is already a known prompt id, so the trace needs no
      // resolve round trip to be attributed.
      traceMeta = { promptId: published.promptId, abTestId: null, variant: null };
      requestBody = substitute(published.promptText);
      promptSource = "registry";

      // The caller's own text still has to reach the registry, or a prompt
      // edited in a new deploy could never appear as a version to promote and
      // the registry would freeze on whatever was released first. Fired and
      // forgotten; its id is not used for this trace.
      // (`published` is only set when systemText is non-null; restated for the
      // type checker, which cannot follow that across the two computations.)
      if (systemText !== null && systemText !== published.promptText) {
        void resolvePrompt(systemText);
      }
    } else if (systemText !== null) {
      resolvePromise = resolvePrompt(systemText);
    }

    // Generated here rather than by the database so the host application can
    // hold it before the call even reaches OpenAI, and so an outcome can be
    // recorded for a request that ultimately fails.
    const clientTraceId = randomId();
    if (onTrace) {
      try {
        onTrace({
          traceId: clientTraceId,
          promptName,
          abTestId: traceMeta?.abTestId ?? undefined,
          variant: (traceMeta?.variant ?? undefined) as "A" | "B" | undefined,
          promptSource,
          releaseId: published?.releaseId,
        });
      } catch (err) {
        // A throwing callback is the host application's bug, not a reason to
        // fail the model call it is observing.
        if (onError) onError(err, { operation: "telemetry" });
        else console.error("[promptwatch] onTrace callback threw:", err);
      }
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
          abTestId: traceMeta.abTestId ?? undefined,
          variant: traceMeta.variant ?? undefined,
          clientTraceId,
          ...metrics,
        });
        return;
      }
      if (resolvePromise) {
        void resolvePromise.then((resolved) => {
          if (resolved) telemetry.send({ promptId: resolved.id, clientTraceId, ...metrics });
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
          errorType: classifyError(err),
        });
        throw err;
      }

      const finish = (
        status: "SUCCESS" | "ERROR",
        usage: any,
        firstChunkAt: number | undefined,
        error?: unknown
      ): void => {
        // Latency is time-to-first-chunk, which is what a streaming UI feels.
        const latencyMs = (firstChunkAt ?? Date.now()) - streamStartedAt;
        const { costUsd, pricingUnknown } = usageCost(requestedModel, usage, pricingOverrides);
        emitTrace({
          latencyMs,
          promptTokens: usage?.prompt_tokens ?? 0,
          completionTokens: usage?.completion_tokens ?? 0,
          costUsd,
          pricingUnknown,
          status,
          errorType: status === "ERROR" ? classifyError(error) : undefined,
        });
      };

      return wrapStream(
        rawStream,
        injectedIncludeUsage,
        (outcome: StreamOutcome) => finish("SUCCESS", outcome.usage, outcome.firstChunkAt),
        (err, firstChunkAt) => finish("ERROR", undefined, firstChunkAt, err)
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
        errorType: classifyError(err),
      });
      throw err;
    }

    const latencyMs = Date.now() - startedAt;
    const usage = response?.usage;
    const { costUsd, pricingUnknown } = usageCost(
      requestedModel ?? response?.model,
      usage,
      pricingOverrides
    );

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
