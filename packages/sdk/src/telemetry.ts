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

async function postJson(url: string, body: unknown): Promise<void> {
  const res = await (globalThis.fetch as typeof fetch)(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export class TelemetryClient {
  private pending: Promise<void>[] = [];

  constructor(private readonly backendUrl: string) {}

  send(payload: TracePayload): void {
    const promise = postJson(`${this.backendUrl}/api/traces`, payload).catch((err) => {
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