import OpenAI from "openai";

import { sha256 } from "./hash";
import { DEFAULT_PRICING, MODEL_PRICING, type ModelPricing } from "./pricing";
import { ABCache, assignVariant, type ABTestConfig } from "./abTesting";
import { TelemetryClient } from "./telemetry";

export interface WrapOpenAIOptions {
  promptName: string;
  backendUrl: string;
  getDistinctId?: () => string | undefined;
  cache?: ABCache;
  telemetry?: TelemetryClient;
}

interface ResolveResponse {
  id: number;
  name: string;
  version: number;
}

type CreateFn = OpenAI.Chat.Completions["create"];

const defaultCaches = new Map<string, ABCache>();

function getOrCreateCache(backendUrl: string): ABCache {
  const existing = defaultCaches.get(backendUrl);
  if (existing) return existing;
  const cache = new ABCache();
  cache.start(backendUrl);
  defaultCaches.set(backendUrl, cache);
  return cache;
}

async function postJson<T>(url: string, body: unknown): Promise<T | null> {
  try {
    const res = await (globalThis.fetch as typeof fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  hash: string
): Promise<ResolveResponse | null> {
  return postJson<ResolveResponse>(`${backendUrl}/api/prompts/resolve`, {
    name: promptName,
    promptText,
    hash,
  });
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
  const { promptName, backendUrl, getDistinctId } = options;
  const cache = options.cache ?? getOrCreateCache(backendUrl);
  const telemetry = options.telemetry ?? new TelemetryClient(backendUrl);
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
      resolvePromise = resolvePrompt(backendUrl, promptName, text, sha256(text));
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