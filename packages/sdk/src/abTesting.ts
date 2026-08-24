import { createHash, randomUUID } from "node:crypto";

export interface ABTestConfig {
  id: number;
  promptName: string;
  variantAId: number;
  variantAText: string;
  variantBId: number;
  variantBText: string;
  splitPercent: number;
}

export interface VariantAssignment {
  variant: "A" | "B";
  promptId: number;
  promptText: string;
}

export function assignVariant(test: ABTestConfig, distinctId?: string): VariantAssignment {
  const key = distinctId ?? randomUUID();
  const hash = createHash("sha256").update(`${test.id}:${key}`).digest();
  const bucket = hash.readUInt32BE(0) % 100;
  const variant: "A" | "B" = bucket < test.splitPercent ? "A" : "B";
  return {
    variant,
    promptId: variant === "A" ? test.variantAId : test.variantBId,
    promptText: variant === "A" ? test.variantAText : test.variantBText,
  };
}

function getAuthHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

export class ABCache {
  private tests = new Map<string, ABTestConfig>();
  private timer: NodeJS.Timeout | undefined;
  private backendUrl: string | undefined;
  private apiKey: string | undefined;

  start(backendUrl: string, intervalMs = 30000, apiKey?: string): void {
    this.stop();
    this.backendUrl = backendUrl;
    this.apiKey = apiKey;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  get(promptName: string): ABTestConfig | undefined {
    return this.tests.get(promptName);
  }

  private async refresh(): Promise<void> {
    if (!this.backendUrl) return;
    try {
      const res = await (globalThis.fetch as typeof fetch)(
        `${this.backendUrl}/api/ab-tests/active`,
        { headers: getAuthHeaders(this.apiKey) }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const active = (await res.json()) as ABTestConfig[];
      const next = new Map<string, ABTestConfig>();
      for (const test of active) next.set(test.promptName, test);
      this.tests = next;
    } catch (err) {
      console.error("[promptwatch] ab-cache refresh failed:", err);
    }
  }
}