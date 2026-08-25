import { describe, it, expect, vi } from "vitest";
import { wrapStream, type StreamOutcome, type StreamWrapOptions } from "../streamWrapper";
import { chatCompletionsAdapter } from "../apiAdapters";

/**
 * The Chat Completions swallow rule, taken from the adapter itself rather than
 * restated here — a test that reimplements the thing it checks proves nothing
 * (ADR-9).
 */
function chatOptions(injectedIncludeUsage: boolean): StreamWrapOptions {
  const prepared = chatCompletionsAdapter.prepareStream(
    injectedIncludeUsage ? { stream: true } : { stream: true, stream_options: { include_usage: true } }
  );
  return prepared.streamOptions;
}

/** Minimal async iterable, optionally with an abortable controller like OpenAI's Stream. */
function createAsyncIterable(
  items: any[],
  controller?: { abort: () => void }
): AsyncIterable<any> & { controller?: { abort: () => void }; returned: boolean } {
  let idx = 0;
  const iterable = {
    controller,
    returned: false,
    [Symbol.asyncIterator](): AsyncIterator<any> {
      return {
        next: async () => {
          if (idx >= items.length) return { done: true, value: undefined };
          return { value: items[idx++], done: false };
        },
        return: async () => {
          iterable.returned = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  return iterable;
}

function collectOutcome() {
  const calls: StreamOutcome[] = [];
  return { calls, onDone: (outcome: StreamOutcome) => calls.push(outcome) };
}

describe("wrapStream", () => {
  it("skips the synthetic usage-only chunk when we injected include_usage", async () => {
    const chunks = [
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: " world" } }] },
      { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    const { calls, onDone } = collectOutcome();

    const result: any[] = [];
    for await (const chunk of wrapStream(createAsyncIterable(chunks), chatOptions(true), onDone, () => {})) {
      result.push(chunk);
    }

    expect(result).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect(calls[0].aborted).toBe(false);
    expect(calls[0].firstChunkAt).toBeDefined();
  });

  it("yields the usage chunk when the caller asked for include_usage themselves", async () => {
    const chunks = [
      { choices: [{ delta: { content: "Hello" } }] },
      { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    const { calls, onDone } = collectOutcome();

    const result: any[] = [];
    for await (const chunk of wrapStream(createAsyncIterable(chunks), chatOptions(false), onDone, () => {})) {
      result.push(chunk);
    }

    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    expect(calls[0].usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it("passes real content chunks through in order and unchanged", async () => {
    const chunks = [
      { choices: [{ delta: { content: "a" } }] },
      { choices: [{ delta: { content: "b" } }] },
      { choices: [{ delta: { content: "c" } }] },
    ];

    const result: any[] = [];
    for await (const chunk of wrapStream(createAsyncIterable(chunks), chatOptions(false), () => {}, () => {})) {
      result.push(chunk);
    }

    expect(result).toEqual(chunks);
  });

  it("captures usage from a chunk that carries both content and usage", async () => {
    const chunks = [
      {
        choices: [{ delta: { content: "Hello" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
      { choices: [{ delta: { content: " world" } }] },
    ];
    const { calls, onDone } = collectOutcome();

    const result: any[] = [];
    // injectedIncludeUsage=true must not swallow a chunk that has real choices.
    for await (const chunk of wrapStream(createAsyncIterable(chunks), chatOptions(true), onDone, () => {})) {
      result.push(chunk);
    }

    expect(result).toHaveLength(2);
    expect(calls[0].usage).toEqual({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
  });

  it("still reports telemetry when the consumer breaks out early", async () => {
    const chunks = [
      { choices: [{ delta: { content: "one" } }] },
      { choices: [{ delta: { content: "two" } }] },
      { usage: { prompt_tokens: 9, completion_tokens: 9, total_tokens: 18 } },
    ];
    const { calls, onDone } = collectOutcome();
    const onError = vi.fn();

    const result: any[] = [];
    for await (const chunk of wrapStream(createAsyncIterable(chunks), chatOptions(true), onDone, onError)) {
      result.push(chunk);
      break; // user cancelled the generation
    }

    expect(result).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].aborted).toBe(true);
    expect(calls[0].firstChunkAt).toBeDefined();
  });

  it("aborts the upstream connection when the consumer breaks out early", async () => {
    const abort = vi.fn();
    const source = createAsyncIterable(
      [{ choices: [{ delta: { content: "one" } }] }, { choices: [{ delta: { content: "two" } }] }],
      { abort }
    );

    for await (const _chunk of wrapStream(source, chatOptions(true), () => {}, () => {})) {
      break;
    }

    expect(abort).toHaveBeenCalledTimes(1);
    expect(source.returned).toBe(true);
  });

  it("does not abort the upstream after a normal completion", async () => {
    const abort = vi.fn();
    const source = createAsyncIterable([{ choices: [{ delta: { content: "one" } }] }], { abort });

    for await (const _chunk of wrapStream(source, chatOptions(true), () => {}, () => {})) {
      // drain
    }

    expect(abort).not.toHaveBeenCalled();
  });

  it("reports the error exactly once and rethrows", async () => {
    const failing: AsyncIterable<any> = {
      [Symbol.asyncIterator]() {
        let served = false;
        return {
          next: async () => {
            if (!served) {
              served = true;
              return { value: { choices: [{ delta: { content: "partial" } }] }, done: false };
            }
            throw new Error("upstream exploded");
          },
        };
      },
    };
    const { calls, onDone } = collectOutcome();
    const onError = vi.fn();

    await expect(async () => {
      for await (const _chunk of wrapStream(failing, chatOptions(true), onDone, onError)) {
        // drain until it throws
      }
    }).rejects.toThrow("upstream exploded");

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toBeDefined(); // firstChunkAt was recorded
    expect(calls).toHaveLength(0); // onDone must not also fire
  });

  it("reports an outcome even for a stream that yields nothing", async () => {
    const { calls, onDone } = collectOutcome();

    for await (const _chunk of wrapStream(createAsyncIterable([]), chatOptions(true), onDone, () => {})) {
      // nothing
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].firstChunkAt).toBeUndefined();
    expect(calls[0].aborted).toBe(false);
  });
});
