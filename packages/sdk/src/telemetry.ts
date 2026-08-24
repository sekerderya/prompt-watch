export interface TracePayload {
  promptId: number;
  abTestId?: number;
  variant?: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  status: "SUCCESS" | "ERROR";
}

const MAX_PENDING = 50;

function getAuthHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

async function postJson(url: string, body: unknown, apiKey?: string): Promise<void> {
  const res = await (globalThis.fetch as typeof fetch)(url, {
    method: "POST",
    headers: getAuthHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export class TelemetryClient {
  private pending: Promise<void>[] = [];

  constructor(
    private readonly backendUrl: string,
    private readonly apiKey?: string
  ) {}

  send(payload: TracePayload): void {
    const promise = postJson(`${this.backendUrl}/api/traces`, payload, this.apiKey).catch((err) => {
      console.error("[promptwatch] trace send failed:", err);
    });
    this.pending.push(promise);
    if (this.pending.length > MAX_PENDING) {
      this.pending.shift();
    }
  }

  async flush(): Promise<void> {
    const batch = this.pending;
    this.pending = [];
    await Promise.allSettled(batch);
  }
}