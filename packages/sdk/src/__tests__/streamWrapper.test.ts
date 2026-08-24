import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { wrapStream } from "../streamWrapper";

// Use a simple array as the source, wrapped in an async iterable factory
function createAsyncIterable(items: any[]): AsyncIterable<any> {
  let idx = 0;
  return {
    [Symbol.asyncIterator](): AsyncIterator<any> {
      return {
        next: async () => {
          if (idx >= items.length) {
            return { done: true, value: undefined };
          }
          return { value: items[idx++], done: false };
        }
      };
    },
  };
}

describe("wrapStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should skip synthetic usage-only chunks when injectedIncludeUsage is true", async () => {
    const chunks = [
      { content: "Hello" }, // normal content chunk
      { content: " world" }, // normal content chunk
      { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }, // synthetic usage-only chunk
    ];

    const result: any[] = [];
    let onDoneUsage: any = undefined;
    let onDoneFirstChunkAt: number | undefined = undefined;

    const stream = wrapStream(
      createAsyncIterable(chunks),
      true, // injectedIncludeUsage = true
      (usage, firstChunkAt) => {
        onDoneUsage = usage;
        onDoneFirstChunkAt = firstChunkAt;
      },
      (_err, _firstChunkAt) => {
        // onError should not be called
      }
    );

    for await (const chunk of stream) {
      result.push(chunk);
    }

    expect(result.length).toBe(2);
    expect(result[0]).toEqual({ content: "Hello" });
    expect(result[1]).toEqual({ content: " world" });
    expect(onDoneUsage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect(onDoneFirstChunkAt).toBeDefined();
  });

  it("should yield synthetic usage chunk normally when injectedIncludeUsage is false", async () => {
    const chunks = [
      { content: "Hello" },
      { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }, // synthetic usage chunk
    ];

    const result: any[] = [];
    let onDoneUsage: any = undefined;

    const stream = wrapStream(
      createAsyncIterable(chunks),
      false, // injectedIncludeUsage = false
      (usage) => {
        onDoneUsage = usage;
      },
      (_err, _firstChunkAt) => {}
    );

    for await (const chunk of stream) {
      result.push(chunk);
    }

    expect(result.length).toBe(2);
    expect(result[0]).toEqual({ content: "Hello" });
    expect(result[1]).toEqual({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    expect(onDoneUsage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it("should pass through all real content chunks in order and unchanged", async () => {
    const chunks = [
      { role: "assistant", content: "Hello" },
      { role: "assistant", content: " world" },
      { role: "assistant", content: "!" },
    ];

    const result: any[] = [];

    const stream = wrapStream(
      createAsyncIterable(chunks),
      false,
      () => {},
      () => {}
    );

    for await (const chunk of stream) {
      result.push(chunk);
    }

    expect(result.length).toBe(3);
    expect(result[0]).toEqual({ role: "assistant", content: "Hello" });
    expect(result[1]).toEqual({ role: "assistant", content: " world" });
    expect(result[2]).toEqual({ role: "assistant", content: "!" });
  });

  it("should capture usage from chunks that have both content and usage when injectedIncludeUsage=false", async () => {
    const chunks = [
      { content: "Hello", usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
      { content: " world" },
    ];

    const result: any[] = [];
    let onDoneUsage: any = undefined;

    const stream = wrapStream(
      createAsyncIterable(chunks),
      false,
      (usage) => {
        onDoneUsage = usage;
      },
      () => {}
    );

    for await (const chunk of stream) {
      result.push(chunk);
    }

    expect(result.length).toBe(2);
    expect(result[0]).toEqual({ content: "Hello", usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
    expect(result[1]).toEqual({ content: " world" });
    expect(onDoneUsage).toEqual({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
  });

  it("should skip synthetic usage-only chunks when injectedIncludeUsage=true and assert yielded chunks match", async () => {
    const chunks = [
      { content: "Hello" }, // normal content chunk
      { content: " world" }, // normal content chunk
      { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }, // synthetic usage-only chunk
    ];

    const result: any[] = [];
    let onDoneUsage: any = undefined;
    let onDoneFirstChunkAt: number | undefined = undefined;

    const stream = wrapStream(
      createAsyncIterable(chunks),
      true, // injectedIncludeUsage = true
      (usage, firstChunkAt) => {
        onDoneUsage = usage;
        onDoneFirstChunkAt = firstChunkAt;
      },
      (_err, _firstChunkAt) => {
        // onError should not be called
      }
    );

    for await (const chunk of stream) {
      result.push(chunk);
    }

    // Only the 2 real content chunks should remain; synthetic usage chunk is skipped
    expect(result.length).toBe(2);
    expect(result[0]).toEqual({ content: "Hello" });
    expect(result[1]).toEqual({ content: " world" });
    // onDone should receive the captured usage from the skipped chunk
    expect(onDoneUsage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    // firstChunkAt should be set when the first real chunk is yielded
    expect(onDoneFirstChunkAt).toBeDefined();
  });
});