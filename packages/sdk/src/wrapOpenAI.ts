import OpenAI from "openai";

import { sha256 } from "./hash";
import { DEFAULT_PRICING, MODEL_PRICING, type ModelPricing } from "./pricing";
import { ABCache, assignVariant, type ABTestConfig } from "./abTesting";
import { TelemetryClient } from "./telemetry";
import { wrapStream } from "./streamWrapper";

export interface WrapOpenAIOptions {
  promptName: string;
  backendUrl: string;
  getDistinctId?: () => string | undefined;
  cache?: ABCache;
  telemetry?: TelemetryClient;
  apiKey?: string;
}

interface ResolveResponse {
  id: number;
  name: string;
  version: number;
}

type CreateFn = OpenAI.Chat.Completions["create"];

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

function getAuthHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

async function postJson<T>(
  url: string,
  body: unknown,
  apiKey?: string
): Promise<T | null> {
  try {
    const res = await (globalThis.fetch as typeof fetch)(url, {
      method: "POST",
      headers: getAuthHeaders(apiKey),
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (err) {
    console.error("[promptwatch] backend request failed:", err);
    return null;
  }
}

function resolvePrompt(
  backendUrl: string,
  promptName: string,
  promptText: string,
  hash: string,
  apiKey?: string
): Promise<ResolveResponse | null> {
  return postJson<ResolveResponse>(
    `${backendUrl}/api/prompts/resolve`,
    { name: promptName, promptText, hash },
    apiKey
  );
}

function costUsd(
  model: string,
  usage: { prompt_tokens: number; completion_tokens: number }
): number {
  const pricing: ModelPricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;
  return (
    pricing.promptPricePer1k * (usage.prompt_tokens / 1000) +
    pricing.completionPricePer1k * (usage.completion_tokens / 1000)
  );
}

interface TraceMeta {
  promptId: number;
  abTestId: number;
  variant: string;
}

export function wrapOpenAI(client: OpenAI, options: WrapOpenAIOptions): OpenAI {
  const { promptName, backendUrl, getDistinctId, apiKey } = options;
  const cache = options.cache ?? getOrCreateCache(backendUrl, apiKey);
  const telemetry = options.telemetry ?? new TelemetryClient(backendUrl, apiKey);
  const completions = client.chat.completions;
  const originalCreate = completions.create.bind(completions);

  const wrappedCreate = (async (
    body: { messages?: { role?: string; content?: unknown }[] },
    requestOptions?: unknown
  ) => {
    const messages = body.messages ?? [];
    const systemIndex = messages.findIndex((m) => m.role === "system");
    const systemMessage = systemIndex >= 0 ? messages[systemIndex] : undefined;

    let activeTest: ABTestConfig | undefined;
    if (systemMessage && typeof systemMessage.content === "string") {
      activeTest = cache.get(promptName);
    }

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
    } else if (systemMessage && typeof systemMessage.content === "string") {
      const text = systemMessage.content;
      resolvePromise = resolvePrompt(backendUrl, promptName, text, sha256(text), apiKey);
    }

    if ((requestBody as any).stream === true) {
      const body: any = requestBody;
      const originalStreamOptions = body.stream_options;
      const injectedIncludeUsage = !originalStreamOptions?.include_usage;
      const finalBody = injectedIncludeUsage
        ? { ...body, stream_options: { ...originalStreamOptions, include_usage: true } }
        : body;

      const streamStartedAt = Date.now();
      const rawStream: any = await originalCreate(finalBody as never, requestOptions as never);

      const sendTrace = (
        status: "SUCCESS" | "ERROR",
        usage: any,
        firstChunkAt: number | undefined
      ) => {
        const latencyMs = (firstChunkAt ?? Date.now()) - streamStartedAt;
        const promptTokens = usage?.prompt_tokens ?? 0;
        const completionTokens = usage?.completion_tokens ?? 0;
        const cost = usage ? costUsd(finalBody.model, usage) : 0;

        if (traceMeta) {
          telemetry.send({
            promptId: traceMeta.promptId,
            abTestId: traceMeta.abTestId,
            variant: traceMeta.variant,
            latencyMs,
            promptTokens,
            completionTokens,
            costUsd: cost,
            status,
          });
        } else if (resolvePromise) {
          resolvePromise.then((resolved) => {
            if (!resolved) return;
            telemetry.send({
              promptId: resolved.id,
              latencyMs,
              promptTokens,
              completionTokens,
              costUsd: cost,
              status,
            });
          });
        }
      };

      return wrapStream(
        rawStream,
        injectedIncludeUsage,
        (usage, firstChunkAt) => sendTrace("SUCCESS", usage, firstChunkAt),
        (_err, firstChunkAt) => sendTrace("ERROR", undefined, firstChunkAt ?? undefined)
      ) as any;
    }

    const startedAt = Date.now();
    const response: any = await originalCreate(requestBody as never, requestOptions as never);
    const latencyMs = Date.now() - startedAt;
    const usage = response?.usage;

    if (usage) {
      if (traceMeta) {
        telemetry.send({
          promptId: traceMeta.promptId,
          abTestId: traceMeta.abTestId,
          variant: traceMeta.variant,
          latencyMs,
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          costUsd: costUsd(response?.model, usage),
          status: "SUCCESS",
        });
      } else if (resolvePromise) {
        const resolved = await resolvePromise;
        if (resolved) {
          telemetry.send({
            promptId: resolved.id,
            latencyMs,
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            costUsd: costUsd(response?.model, usage),
            status: "SUCCESS",
          });
        }
      }
    }

    return response;
  }) as unknown as CreateFn;

  (client.chat.completions as unknown as { create: CreateFn }).create = wrappedCreate;
  return client;
}