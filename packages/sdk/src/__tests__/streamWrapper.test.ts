import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { wrapStream } from "../streamWrapper";

// Use a simple array as the source, wrapped in an async iterable factory
function createAsyncIterable<T>(items: any[]): AsyncIterable<any> {
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
    };
  };
}

describe("wrapStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(()>