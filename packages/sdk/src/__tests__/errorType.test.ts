import { describe, it, expect } from "vitest";
import { classifyError } from "../errorType";

/** Mirrors the shape the OpenAI SDK throws. */
function apiError(status: number, name = "APIError") {
  const error = new Error("something went wrong") as Error & { status: number };
  error.name = name;
  error.status = status;
  return error;
}

function systemError(code: string, name = "Error") {
  const error = new Error("socket problem") as Error & { code: string };
  error.name = name;
  error.code = code;
  return error;
}

describe("classifyError", () => {
  it("maps the HTTP statuses that need different responses", () => {
    expect(classifyError(apiError(429))).toBe("RATE_LIMIT");
    expect(classifyError(apiError(401))).toBe("AUTH");
    expect(classifyError(apiError(403))).toBe("AUTH");
    expect(classifyError(apiError(404))).toBe("NOT_FOUND");
    expect(classifyError(apiError(408))).toBe("TIMEOUT");
    expect(classifyError(apiError(400))).toBe("INVALID_REQUEST");
    expect(classifyError(apiError(422))).toBe("INVALID_REQUEST");
    expect(classifyError(apiError(500))).toBe("SERVER");
    expect(classifyError(apiError(503))).toBe("SERVER");
  });

  it("treats an unlisted 4xx as a client problem", () => {
    expect(classifyError(apiError(418))).toBe("INVALID_REQUEST");
  });

  it("recognises cancellation", () => {
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    expect(classifyError(aborted)).toBe("CANCELLED");
    expect(classifyError(systemError("ABORT_ERR"))).toBe("CANCELLED");
  });

  it("recognises timeouts and connection failures without a status", () => {
    expect(classifyError(systemError("ETIMEDOUT"))).toBe("TIMEOUT");
    expect(classifyError(apiError(0, "APIConnectionTimeoutError"))).toBe("TIMEOUT");
    expect(classifyError(systemError("ECONNREFUSED"))).toBe("NETWORK");
    expect(classifyError(systemError("ENOTFOUND"))).toBe("NETWORK");
    expect(classifyError(apiError(0, "APIConnectionError"))).toBe("NETWORK");
  });

  it("falls back to UNKNOWN rather than guessing", () => {
    expect(classifyError(new Error("plain"))).toBe("UNKNOWN");
    expect(classifyError(null)).toBe("UNKNOWN");
    expect(classifyError("a string")).toBe("UNKNOWN");
    expect(classifyError(undefined)).toBe("UNKNOWN");
  });

  it("never reads the error message, so user content cannot leak", () => {
    const leaky = new Error("user asked about SSN 123-45-6789") as Error & { status: number };
    leaky.status = 500;
    // The category is derived from the status alone; the message is untouched.
    expect(classifyError(leaky)).toBe("SERVER");
  });
});
