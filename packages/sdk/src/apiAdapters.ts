import type { StreamWrapOptions } from "./streamWrapper";

/**
 * The only differences between the two OpenAI APIs that PromptWatch cares about.
 *
 * Chat Completions carries the system prompt as a `role: "system"` message and
 * reports `prompt_tokens`/`completion_tokens`; the Responses API carries it as
 * `instructions` and reports `input_tokens`/`output_tokens`. Everything else —
 * precedence, error traces, non-blocking telemetry, cost, outcomes — is
 * identical, so it is written once and both adapters feed into it.
 *
 * Keeping the differences in one small table is the point. The last time this
 * project had two near-identical code paths, one of them silently stopped
 * recording errors for months (ADR-9).
 */
export interface ApiAdapter {
  readonly name: "chat.completions" | "responses";

  /** The system-prompt equivalent, or null when the call has none to track. */
  readPrompt(body: any): string | null;

  /** A copy of the body with the prompt replaced. Never mutates the original. */
  writePrompt(body: any, text: string): any;

  isStreaming(body: any): boolean;

  /**
   * Prepare a streaming request, and say how the resulting stream should be
   * read. Returning the body unchanged is always a valid choice.
   */
  prepareStream(body: any): { body: any; streamOptions: StreamWrapOptions };

  /** Usage from a non-streaming response, in whatever shape the API uses. */
  readUsage(response: any): unknown;
}

export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Reads token counts from either API's usage object.
 *
 * Deliberately tolerant: an unrecognised shape yields `undefined`, which the
 * caller already handles by recording a trace with zero tokens. A provider
 * renaming a field should cost the cost figure, never the whole trace.
 */
export function normalizeUsage(usage: unknown): NormalizedUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;

  const promptTokens =
    typeof u.prompt_tokens === "number"
      ? u.prompt_tokens
      : typeof u.input_tokens === "number"
        ? u.input_tokens
        : undefined;

  const completionTokens =
    typeof u.completion_tokens === "number"
      ? u.completion_tokens
      : typeof u.output_tokens === "number"
        ? u.output_tokens
        : undefined;

  if (promptTokens === undefined && completionTokens === undefined) return undefined;
  return { promptTokens: promptTokens ?? 0, completionTokens: completionTokens ?? 0 };
}

export const chatCompletionsAdapter: ApiAdapter = {
  name: "chat.completions",

  readPrompt(body) {
    const messages = body?.messages;
    if (!Array.isArray(messages)) return null;
    const system = messages.find((m: any) => m?.role === "system");
    return typeof system?.content === "string" ? system.content : null;
  },

  writePrompt(body, text) {
    const messages = body.messages ?? [];
    const systemIndex = messages.findIndex((m: any) => m?.role === "system");
    return {
      ...body,
      messages: messages.map((m: any, i: number) =>
        i === systemIndex ? { ...m, content: text } : m
      ),
    };
  },

  isStreaming(body) {
    return body?.stream === true;
  },

  prepareStream(body) {
    // Chat Completions only reports usage on a stream if asked, so it is asked —
    // and the extra chunk that produces is hidden from the caller again.
    const originalStreamOptions = body.stream_options;
    const injected = !originalStreamOptions?.include_usage;
    return {
      body: injected
        ? { ...body, stream_options: { ...originalStreamOptions, include_usage: true } }
        : body,
      streamOptions: {
        isSyntheticUsageChunk: (chunk: any) =>
          injected &&
          Boolean(chunk?.usage) &&
          !(Array.isArray(chunk?.choices) && chunk.choices.length > 0),
      },
    };
  },

  readUsage(response) {
    return response?.usage;
  },
};

export const responsesAdapter: ApiAdapter = {
  name: "responses",

  readPrompt(body) {
    return typeof body?.instructions === "string" ? body.instructions : null;
  },

  writePrompt(body, text) {
    return { ...body, instructions: text };
  },

  isStreaming(body) {
    return body?.stream === true;
  },

  prepareStream(body) {
    // Nothing is injected and nothing is swallowed. The Responses API already
    // reports usage on its terminal `response.completed` event, so the wrapper
    // can stay purely observational — which also means no assumption of mine
    // about this API's request options can corrupt a caller's stream.
    return {
      body,
      streamOptions: {
        readUsage: (event: any) => event?.response?.usage ?? event?.usage,
      },
    };
  },

  readUsage(response) {
    return response?.usage;
  },
};
